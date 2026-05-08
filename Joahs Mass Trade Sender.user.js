// ==UserScript==
// @name         Mass Trade Sender
// @namespace    https://tampermonkey.net/
// @version      1.0
// @description  Send trades to everyone selling a specific item
// @author       extracted from Korone All-In-One
// @match        *://*.pekora.zip/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      www.pekora.zip
// @connect      pekora.zip
// @connect      koromons.lol
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ─── Constants ────────────────────────────────────────────────────────────
    const BASE          = 'https://www.pekora.zip';
    const EP_KOROMONS   = 'https://koromons.lol/api/items';
    const EP_INVENTORY  = BASE + '/apisite/inventory/v1/users/{uid}/assets/collectibles';
    const EP_ASSET_THUMB = BASE + '/apisite/thumbnails/v1/assets';
    const EP_TRADE_SEND = BASE + '/apisite/trades/v1/trades/send';

    // Roblox enforces 4 items per trade side server-side.
    // Pekora may allow more. Raise this if the API accepts it.
    const MAX_SELECT = 8;

    // ─── State ────────────────────────────────────────────────────────────────
    let koromonsItems = {};
    let assetThumbs   = {};
    let assetValues   = {};
    let csrfToken     = null;

    let blastState = {
        myUserId: null,
        myItems: [], mySelected: [],
        targetAssetId: null, targetOwners: [],
        sending: false, stopped: false,
        maxSendCount: null, logs: [],
        delaySeconds: 20
    };

    const ITEM_FB = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3Crect fill='%231e1208' width='1' height='1'/%3E%3C/svg%3E";

    // ─── Utilities ────────────────────────────────────────────────────────────
    function esc(s) {
        const d = document.createElement('div');
        d.textContent = String(s != null ? s : '');
        return d.innerHTML;
    }

    function extractCsrf(h) {
        if (!h) return;
        const m = h.match(/x-csrf-token:\s*([^\r\n]+)/i);
        if (m) csrfToken = m[1].trim();
    }

    function apiGet(url, creds) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url,
                headers: { Accept: 'application/json' },
                withCredentials: !!creds,
                onload(r) {
                    extractCsrf(r.responseHeaders);
                    if (r.status >= 200 && r.status < 300) {
                        try { resolve(JSON.parse(r.responseText)); }
                        catch { reject(new Error('Bad JSON')); }
                    } else reject(new Error('HTTP ' + r.status));
                },
                onerror(e) { reject(e); }
            });
        });
    }

    function apiPost(url, body, attempt) {
        attempt = attempt || 0;
        return new Promise((resolve, reject) => {
            const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
            if (csrfToken) headers['x-csrf-token'] = csrfToken;
            GM_xmlhttpRequest({
                method: 'POST', url, headers,
                withCredentials: true,
                data: typeof body === 'string' ? body : JSON.stringify(body || {}),
                onload(r) {
                    extractCsrf(r.responseHeaders);
                    if (r.status === 403 && attempt < 3)
                        return apiPost(url, body, attempt + 1).then(resolve).catch(reject);
                    if (r.status >= 200 && r.status < 300) {
                        try { resolve(JSON.parse(r.responseText || '{}')); } catch { resolve({}); }
                    } else {
                        let msg = 'HTTP ' + r.status;
                        try { const j = JSON.parse(r.responseText); if (j.errors?.[0]) msg = j.errors[0].message; } catch {}
                        reject(new Error(msg));
                    }
                },
                onerror(e) { reject(e); }
            });
        });
    }

    // Seed CSRF token before first POST
    async function seedCsrf() {
        try { await apiPost(BASE + '/apisite/trades/v1/trades/0/accept', {}); } catch {}
    }

    async function getMyUserId() {
        if (blastState.myUserId) return blastState.myUserId;
        try {
            const j = await apiGet(BASE + '/apisite/users/v1/users/authenticated', true);
            if (j?.id) { blastState.myUserId = j.id; return j.id; }
        } catch {}
        const m = document.cookie.match(/userid=(\d+)/i);
        if (m) { blastState.myUserId = parseInt(m[1]); return blastState.myUserId; }
        return null;
    }

    async function fetchKoromons() {
        try {
            const j = await apiGet(EP_KOROMONS, false);
            if (Array.isArray(j)) {
                const m = {};
                for (const it of j) {
                    const itemId = it.itemId || it.assetId;
                    if (itemId) {
                        const value = it.Value || it.value || 0;
                        m[itemId] = {
                            assetId: itemId,
                            name: it.Name || it.name,
                            value, rap: value,
                            demand: it.Demand || it.demand,
                            trend: it.Trend || it.trend
                        };
                    }
                }
                koromonsItems = m;
            }
        } catch {}
    }

    function getKoromons(id) { return koromonsItems[id] || null; }

    async function fetchAssetThumbs(assetIds) {
        if (!assetIds.length) return {};
        const needed = assetIds.filter(id => !assetThumbs[id]);
        for (let i = 0; i < needed.length; i += 30) {
            const chunk = needed.slice(i, i + 30);
            try {
                const j = await apiGet(EP_ASSET_THUMB + '?assetIds=' + chunk.join(',') + '&format=png&size=420x420', true);
                if (Array.isArray(j.data)) {
                    for (const e of j.data) {
                        if (e.state === 'Completed' && e.imageUrl) {
                            assetThumbs[e.targetId] = e.imageUrl.startsWith('http') ? e.imageUrl : BASE + e.imageUrl;
                        }
                    }
                }
            } catch {}
        }
    }

    async function fetchInventory(uid) {
        const all = []; let cursor = '';
        while (true) {
            const q = new URLSearchParams({ limit: '100' });
            if (cursor) q.set('cursor', cursor);
            try {
                const j = await apiGet(EP_INVENTORY.replace('{uid}', uid) + '?' + q, true);
                all.push(...(j.data || []));
                if (j.nextPageCursor) cursor = j.nextPageCursor; else break;
            } catch { break; }
        }
        return all;
    }

    // Fetches all resellers of assetId — gives userId + userAssetId directly.
    // This is the correct endpoint for pekora; the inventory/v2/owners endpoint returns bad JSON.
async function fetchAssetOwners(assetId) {
    const owners = [];
    let cursor = '';
    let pages = 0;
    let useResellers = false;

    // Try the full owners endpoint first
    // If it fails/returns bad data, fall back to resellers (sellers only)
    try {
        const test = await apiGet(BASE + '/apisite/inventory/v2/assets/' + assetId + '/owners?limit=1', true);
        if (!test || (!test.data && !test.nextPageCursor)) useResellers = true;
    } catch {
        useResellers = true;
    }

    const endpoint = useResellers
        ? BASE + '/apisite/economy/v1/assets/' + assetId + '/resellers?limit=100'
        : BASE + '/apisite/inventory/v2/assets/' + assetId + '/owners?limit=100';

    mtLog(useResellers ? 'Using resellers (sellers only)' : 'Using owners endpoint (all owners)', 'info');

    while (pages < 100) {
        pages++;
        let url = endpoint;
        if (cursor) url += '&cursor=' + encodeURIComponent(cursor);
        try {
            const j = await apiGet(url, true);
            const items = j.data || [];
            for (const e of items) {
                let userId, username, userAssetId;
                if (useResellers) {
                    const seller = e.seller || {};
                    userId      = seller.id || seller.userId;
                    username    = seller.name || seller.displayName || ('User #' + userId);
                    userAssetId = e.userAssetId;
                } else {
                    // inventory/v2/owners format
                    const owner = e.owner || e.user || e;
                    userId      = owner.id || owner.userId;
                    username    = owner.displayName || owner.name || ('User #' + userId);
                    userAssetId = e.userAssetId || e.id;
                }
                if (userId && userAssetId) owners.push({ userId, username, userAssetId });
            }
            if (j.nextPageCursor) cursor = j.nextPageCursor;
            else break;
        } catch (e) {
            console.error('[MTS] fetchAssetOwners page ' + pages + ':', e);
            break;
        }
    }

    console.log('[MTS] Found ' + owners.length + ' owners/sellers');
    return owners;
}

    function updateMassTradeTotal() {
        const rapEl   = document.getElementById('mt-total-rap');
        const valueEl = document.getElementById('mt-total-value');
        if (!rapEl || !valueEl) return;
        let totalRap = 0, totalValue = 0;
        for (const item of blastState.mySelected) {
            totalRap   += item.recentAveragePrice || 0;
            totalValue += assetValues[item.assetId] || 0;
        }
        rapEl.textContent   = totalRap.toLocaleString();
        valueEl.textContent = totalValue.toLocaleString();
    }

    function showConfirm(msg, onYes) {
        const old = document.getElementById('mts-tc');
        if (old) old.remove();
        const overlay = document.createElement('div');
        overlay.id = 'mts-tc';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.7);z-index:1000000000;display:flex;align-items:center;justify-content:center';
        const box = document.createElement('div');
        box.style.cssText = 'background:#251508;border:1px solid #c8944a;border-radius:10px;padding:24px 28px;max-width:420px;width:90%;font-family:"Gotham SSm","Gotham",sans-serif;color:#f0e0c0';
        box.innerHTML = '<div style="font-size:14px;font-weight:700;margin-bottom:16px;white-space:pre-wrap">' + esc(msg) + '</div>' +
            '<div style="display:flex;gap:10px;justify-content:flex-end">' +
            '<button id="mts-tc-no"  style="padding:8px 20px;border:1px solid #3d2810;border-radius:6px;background:#130c05;color:#8c6840;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit">Cancel</button>' +
            '<button id="mts-tc-yes" style="padding:8px 20px;border:none;border-radius:6px;background:#c8944a;color:#1e1208;font-weight:800;font-size:13px;cursor:pointer;font-family:inherit">Confirm</button>' +
            '</div>';
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        box.querySelector('#mts-tc-yes').addEventListener('click', () => { overlay.remove(); onYes(); });
        box.querySelector('#mts-tc-no').addEventListener('click',  () => overlay.remove());
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    }

    // ─── CSS ──────────────────────────────────────────────────────────────────
    function injectCss() {
        if (document.getElementById('mts-style')) return;
        const s = document.createElement('style');
        s.id = 'mts-style';
        s.textContent =
'@keyframes mts-fi{from{opacity:0}to{opacity:1}}' +
'@keyframes mts-cpi{from{opacity:0;transform:translate(-50%,-50%) translateY(-16px)}to{opacity:1;transform:translate(-50%,-50%) translateY(0)}}' +

// FAB
'#mts-fab{position:fixed;bottom:28px;right:28px;z-index:99998;width:48px;height:48px;border-radius:50%;background:#c8944a;color:#1e1208;border:none;cursor:pointer;font-size:20px;font-weight:900;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 18px rgba(200,148,74,.45);transition:transform .15s,box-shadow .15s;font-family:"Gotham SSm","Gotham",sans-serif}' +
'#mts-fab:hover{transform:scale(1.1);box-shadow:0 6px 24px rgba(200,148,74,.6)}' +

// Overlay + panel
'#mass-trade-ov{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(10,6,3,.82);z-index:999998;animation:mts-fi .2s ease;backdrop-filter:blur(2px)}' +
'#mass-trade-panel{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:700px;max-width:95vw;max-height:90vh;background:#1e1208;border-radius:10px;z-index:999999;display:flex;flex-direction:column;box-shadow:0 16px 48px rgba(0,0,0,.85),0 0 0 1px #3d2810;font-family:"Gotham SSm","Gotham",sans-serif;overflow:hidden;animation:mts-cpi .2s ease}' +

// Header
'.mt-h{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:2px solid #3d2810;background:linear-gradient(135deg,#130c05,#1e1208)}' +
'.mt-hl{display:flex;align-items:center;gap:8px}.mt-title{font-size:16px;font-weight:700;color:#f0e0c0;letter-spacing:-.2px}' +
'.mt-x{color:#8c6840;font-size:20px;cursor:pointer;padding:4px 8px;font-weight:700;border-radius:4px;transition:all .15s}.mt-x:hover{color:#f0e0c0;background:#3d2810}' +

// Body
'.mt-body{padding:16px;overflow-y:auto;display:flex;flex-direction:column;gap:16px;max-height:calc(90vh - 60px)}' +
'.mt-body::-webkit-scrollbar{width:8px}.mt-body::-webkit-scrollbar-track{background:#130c05}.mt-body::-webkit-scrollbar-thumb{background:#3d2810;border-radius:4px}' +
'.mt-step{background:#251508;border-radius:8px;padding:14px;border:1px solid #3d2810}' +
'.mt-step-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#8c6840;margin-bottom:10px}' +
'.mt-count{color:#c8944a;font-weight:700}' +

// Inputs / buttons
'.mt-row{display:flex;gap:8px;align-items:center}' +
'.mt-input{flex:1;height:36px;padding:0 12px;background:#130c05;border:1px solid #3d2810;border-radius:6px;color:#f0e0c0;font-size:13px;font-family:inherit;outline:none;transition:border-color .2s}.mt-input:focus{border-color:#c8944a}.mt-input::placeholder{color:#5a3e28}' +
'.mt-btn{padding:8px 16px;border:none;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .15s;display:inline-flex;align-items:center;gap:6px}' +
'.mt-btn-blue{background:#8b5e2e;color:#f0e0c0;border:1px solid #c8944a}.mt-btn-blue:hover{background:#c8944a;color:#1e1208}' +
'.mt-btn-green{background:#c8944a;color:#1e1208;width:100%;justify-content:center;padding:12px;font-size:14px;font-weight:800;border:none}.mt-btn-green:hover:not(:disabled){background:#d9a85e;transform:translateY(-1px);box-shadow:0 4px 16px rgba(200,148,74,.35)}' +
'.mt-btn-green:disabled{opacity:.35;cursor:not-allowed}' +
'.mt-fullw{width:100%;justify-content:center}' +
'.mt-small-btn{width:26px;height:26px;border:1px solid #3d2810;background:#130c05;color:#c8944a;font-size:14px;font-weight:700;border-radius:4px;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;justify-content:center}.mt-small-btn:hover{background:#3d2810;border-color:#c8944a;color:#f0e0c0}' +
'.mt-max-btn{padding:4px 10px;border:1px solid #3d2810;background:#130c05;color:#8c6840;font-size:10px;font-weight:700;border-radius:4px;cursor:pointer;transition:all .15s;white-space:nowrap}.mt-max-btn:hover{background:#3d2810;border-color:#c8944a;color:#c8944a}' +
'.mt-btn-red{background:#8b2a20;color:#f0e0c0;border:1px solid #c0392b}.mt-btn-red:hover{background:#c0392b}' +

// Item grids
'.mt-placeholder{color:#5a3e28;text-align:center;padding:30px 0;font-size:13px}' +
'.mt-items-grid-wrap{max-height:220px;overflow-y:auto;margin-top:4px}.mt-items-grid-wrap::-webkit-scrollbar{width:6px}.mt-items-grid-wrap::-webkit-scrollbar-track{background:#130c05}.mt-items-grid-wrap::-webkit-scrollbar-thumb{background:#3d2810;border-radius:3px}' +
'.mt-items-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:6px}' +
'.mt-item-card{background:#130c05;border:1px solid #3d2810;border-radius:6px;padding:6px;cursor:pointer;transition:all .15s;display:flex;flex-direction:column;align-items:center;gap:4px}' +
'.mt-item-card:hover{border-color:#c8944a;transform:translateY(-2px);box-shadow:0 4px 12px rgba(200,148,74,.2)}' +
'.mt-item-card.mt-item-sel{border-color:#c8944a!important;background:#2e1a08!important;box-shadow:0 0 0 1px #c8944a}' +
'.mt-item-card.mt-item-maxed{opacity:.25;cursor:not-allowed;pointer-events:none}' +
'.mt-item-img-wrap{width:70px;height:70px;background:#1e1208;border-radius:4px;overflow:hidden;flex-shrink:0}' +
'.mt-item-img-wrap img{width:100%;height:100%;object-fit:contain}' +
'.mt-item-name{font-size:9px;color:#f0e0c0;font-weight:600;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%}' +
'.mt-item-tags{display:flex;gap:2px;flex-wrap:wrap;justify-content:center}' +
'.mt-tag{font-size:8px;padding:1px 4px;border-radius:2px;font-weight:700}' +
'.mt-tag-v{background:rgba(200,148,74,.25);color:#c8944a}.mt-tag-r{background:rgba(200,148,74,.15);color:#d9a85e}' +

// Target grid
'.mt-blast-target-grid{margin-top:10px;max-height:300px;overflow-y:auto;background:#130c05;border-radius:6px;border:1px solid #3d2810;padding:8px}' +
'.mt-blast-target-grid::-webkit-scrollbar{width:6px}.mt-blast-target-grid::-webkit-scrollbar-track{background:#130c05}.mt-blast-target-grid::-webkit-scrollbar-thumb{background:#3d2810;border-radius:3px}' +

// Summary
'.mt-blast-summary{background:#130c05;border:1px solid #3d2810;border-radius:6px;padding:12px;margin-bottom:10px;font-size:12px;color:#8c6840}' +

// Progress + log
'.mt-progress{height:6px;background:#130c05;border-radius:3px;overflow:hidden;margin-top:8px;border:1px solid #3d2810}' +
'.mt-progress-bar{height:100%;background:linear-gradient(90deg,#8b5e2e,#c8944a);border-radius:3px;transition:width .3s;width:0%}' +
'.mt-log{max-height:120px;overflow-y:auto;margin-top:10px;display:flex;flex-direction:column;gap:4px}.mt-log::-webkit-scrollbar{width:4px}.mt-log::-webkit-scrollbar-thumb{background:#3d2810;border-radius:2px}' +
'.mt-log-item{font-size:11px;padding:5px 8px;border-radius:4px;font-weight:600}' +
'.mt-log-info{background:#251508;color:#c8944a;border-left:3px solid #8b5e2e}.mt-log-ok{background:#1a2a0a;color:#7cb854;border-left:3px solid #4a7a28}.mt-log-err{background:#2a0a0a;color:#e05252;border-left:3px solid #8a2020}' +

// Misc
'.mt-warn-banner{background:rgba(192,57,43,.14);border:1px solid rgba(192,57,43,.45);border-radius:6px;padding:10px 14px;font-size:11px;font-weight:700;color:#e07060;text-align:center;letter-spacing:.3px}' +
'.mt-sel-info{font-size:10px;color:#8c6840;margin-top:6px;padding:4px 8px;background:#130c05;border-radius:4px;border:1px solid #3d2810}';
        document.head.appendChild(s);
    }

    // ─── Panel HTML ───────────────────────────────────────────────────────────
    function showMassTradePanel() {
        const old = document.getElementById('mass-trade-ov');
        if (old) { old.remove(); document.getElementById('mass-trade-panel')?.remove(); return; }
        injectCss();

        const ov = document.createElement('div');
        ov.id = 'mass-trade-ov';
        ov.addEventListener('click', e => { if (e.target === ov) closeMassTradePanel(); });
        document.body.appendChild(ov);

        const panel = document.createElement('div');
        panel.id = 'mass-trade-panel';
        panel.innerHTML =
            '<div class="mt-h">' +
                '<div class="mt-hl"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#c8944a" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg><span class="mt-title">Mass Trade Sender</span></div>' +
                '<span class="mt-x">&#10005;</span>' +
            '</div>' +

            '<div class="mt-body">' +
                '<div class="mt-warn-banner">⚠ ABUSING THIS MAY RESULT IN A BAN. USE AT YOUR OWN RISK.</div>' +

                // Step 1 — Your items
                '<div class="mt-step">' +
                    '<div class="mt-step-label">1. Your Items to Offer <span class="mt-count" id="mt-blast-my-count">(0/' + MAX_SELECT + ')</span></div>' +
                    '<button class="mt-btn mt-btn-blue mt-fullw" id="mt-blast-load-inv">Load My Inventory</button>' +
                    '<div id="mt-blast-my-items" class="mt-items-grid-wrap" style="margin-top:10px"><div class="mt-placeholder">Click above to load</div></div>' +
                    '<div style="margin:8px 0;font-size:12px;color:#8c6840">RAP: <span id="mt-total-rap" style="color:#c8944a;font-weight:700">0</span> &nbsp; Value: <span id="mt-total-value" style="color:#c8944a;font-weight:700">0</span></div>' +
                '</div>' +

                // Step 2 — Target item
                '<div class="mt-step">' +
                    '<div class="mt-step-label">2. Target Item (whose sellers you want to trade with)</div>' +
                    '<div class="mt-row">' +
                        '<input id="mt-blast-asset-input" class="mt-input" placeholder="Filter by name...">' +
                    '</div>' +
                    '<div id="mt-blast-target-grid" class="mt-blast-target-grid">' +
                        '<div style="padding:20px;color:#5a3e28;text-align:center">Loading collectibles...</div>' +
                    '</div>' +
                    '<div id="mt-blast-selected-item" style="display:none;margin-top:10px;padding:10px;background:#130c05;border-radius:6px;border:1px solid #3d2810">' +
                        '<div style="display:flex;align-items:center;gap:10px">' +
                            '<img id="mt-blast-selected-thumb" style="width:60px;height:60px;border-radius:6px;background:#1e1208;object-fit:contain">' +
                            '<div style="flex:1">' +
                                '<div id="mt-blast-selected-name" style="font-size:14px;font-weight:700;color:#f0e0c0;margin-bottom:4px"></div>' +
                                '<div id="mt-blast-owner-count" style="font-size:12px;color:#8c6840"></div>' +
                            '</div>' +
                            '<button class="mt-btn mt-btn-blue" id="mt-blast-find-owners">Find Sellers</button>' +
                        '</div>' +
                    '</div>' +
                '</div>' +

                // Step 3 — Blast
                '<div class="mt-step">' +
                    '<div class="mt-step-label">3. Send Trades</div>' +
                    '<div id="mt-blast-summary" class="mt-blast-summary" style="display:none"></div>' +
                    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
                        '<div style="display:flex;align-items:center;gap:8px">' +
                            '<label style="font-size:11px;color:#8c6840;font-weight:600">Max users:</label>' +
                            '<button class="mt-small-btn" id="mt-max-dec">−</button>' +
                            '<span id="mt-max-display" style="font-size:12px;font-weight:700;color:#f0e0c0;min-width:60px;text-align:center">All</span>' +
                            '<button class="mt-small-btn" id="mt-max-inc">+</button>' +
                            '<button class="mt-max-btn" id="mt-max-all">Max Copies</button>' +
                        '</div>' +
                        '<div style="display:flex;align-items:center;gap:8px">' +
                            '<label style="font-size:11px;color:#8c6840;font-weight:600">Delay:</label>' +
                            '<button class="mt-small-btn" id="mt-delay-dec">−</button>' +
                            '<span id="mt-delay-display" style="font-size:12px;font-weight:700;color:#f0e0c0;min-width:70px;text-align:center">20 sec</span>' +
                            '<button class="mt-small-btn" id="mt-delay-inc">+</button>' +
                        '</div>' +
                    '</div>' +
                    '<div style="display:flex;gap:8px">' +
                        '<button class="mt-btn mt-btn-green" id="mt-blast-btn" disabled>Send All Trades</button>' +
                        '<button class="mt-btn mt-btn-red" id="mt-blast-stop-btn" style="display:none">Stop</button>' +
                    '</div>' +
                    '<div class="mt-progress" id="mt-blast-progress" style="display:none"><div class="mt-progress-bar" id="mt-blast-progress-bar"></div></div>' +
                    '<div class="mt-log" id="mt-blast-log"></div>' +
                '</div>' +
            '</div>';

        document.body.appendChild(panel);
        panel.querySelector('.mt-x').addEventListener('click', closeMassTradePanel);

        // ── Load inventory ────────────────────────────────────────────────
        panel.querySelector('#mt-blast-load-inv').addEventListener('click', async () => {
            const btn = panel.querySelector('#mt-blast-load-inv');
            btn.disabled = true; btn.textContent = 'Loading...';
            try {
                const myUid = await getMyUserId();
                if (!myUid) { mtLog('Not logged in', 'err'); btn.disabled = false; btn.textContent = 'Load My Inventory'; return; }
                if (!Object.keys(koromonsItems).length) await fetchKoromons();
                const items = await fetchInventory(myUid);
                blastState.myItems = items;
                blastState.mySelected = [];
                const ids = [...new Set(items.map(i => i.assetId).filter(Boolean))];
                if (ids.length) await fetchAssetThumbs(ids);
                renderBlastMyGrid();
                btn.textContent = '✓ Loaded (' + items.length + ' items)';
                mtLog('Loaded ' + items.length + ' items', 'ok');
            } catch(e) {
                mtLog('Error loading inventory: ' + e.message, 'err');
                btn.disabled = false; btn.textContent = 'Load My Inventory';
            }
        });

        // ── Load target items grid ────────────────────────────────────────
        let allTargetItems = [];
        (async () => {
            const grid = document.getElementById('mt-blast-target-grid');
            try {
                if (!Object.keys(koromonsItems).length) await fetchKoromons();
                const collectibles = Object.values(koromonsItems).filter(item => {
                    const name = (item.name || '').toLowerCase();
                    if (name.includes('shirt') || name.includes('pants') || name.includes('t-shirt')) return false;
                    if (name.includes('jacket') || name.includes('hoodie') || name.includes('sweater')) return false;
                    return true;
                });
                collectibles.sort((a, b) => (b.value || 0) - (a.value || 0));
                allTargetItems = collectibles; // no cap — all items

                const assetIds = allTargetItems.map(i => i.assetId);
                await fetchAssetThumbs(assetIds);
                renderTargetGrid(allTargetItems);
                mtLog('Loaded ' + allTargetItems.length + ' collectibles', 'ok');
            } catch(e) {
                if (grid) grid.innerHTML = '<div style="padding:20px;color:#e05252;text-align:center">Error: ' + esc(e.message) + '</div>';
                mtLog('Error loading items: ' + e.message, 'err');
            }
        })();

        panel.querySelector('#mt-blast-asset-input').addEventListener('input', e => {
            const q = e.target.value.toLowerCase();
            renderTargetGrid(q ? allTargetItems.filter(i => i.name.toLowerCase().includes(q) || String(i.assetId).includes(q)) : allTargetItems);
        });

        function renderTargetGrid(items) {
            const grid = document.getElementById('mt-blast-target-grid');
            if (!items.length) { grid.innerHTML = '<div style="padding:20px;color:#5a3e28;text-align:center">No items found</div>'; return; }
            grid.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:6px"></div>';
            const container = grid.querySelector('div');
            for (const item of items) {
                const thumb = assetThumbs[item.assetId] || ITEM_FB;
                const card = document.createElement('div');
                card.style.cssText = 'background:#251508;border:2px solid transparent;border-radius:6px;padding:6px;cursor:pointer;transition:all .15s;display:flex;flex-direction:column;align-items:center;gap:4px';
                card.innerHTML =
                    '<img src="' + thumb + '" style="width:70px;height:70px;border-radius:4px;object-fit:contain;background:#130c05">' +
                    '<div style="font-size:9px;font-weight:600;color:#f0e0c0;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%">' + esc(item.name) + '</div>' +
                    '<div style="font-size:8px;color:#c8944a;font-weight:700">' + (item.value || 0).toLocaleString() + '</div>';
                card.addEventListener('mouseenter', () => { card.style.borderColor = '#c8944a'; card.style.background = '#3d2810'; });
                card.addEventListener('mouseleave', () => { card.style.borderColor = 'transparent'; card.style.background = '#251508'; });
                card.addEventListener('click', () => {
                    blastState.targetAssetId = item.assetId;
                    document.getElementById('mt-blast-selected-thumb').src = thumb;
                    document.getElementById('mt-blast-selected-name').textContent = item.name;
                    document.getElementById('mt-blast-selected-item').style.display = 'block';
                    document.getElementById('mt-blast-owner-count').textContent = 'Click "Find Sellers" to search';
                    mtLog('Selected target: ' + item.name, 'ok');
                });
                container.appendChild(card);
            }
        }

        // ── Find sellers ──────────────────────────────────────────────────
        panel.querySelector('#mt-blast-find-owners').addEventListener('click', async () => {
            if (!blastState.targetAssetId) { mtLog('Select an item first', 'err'); return; }
            const btn = panel.querySelector('#mt-blast-find-owners');
            btn.disabled = true; btn.textContent = 'Finding...';
            document.getElementById('mt-blast-owner-count').textContent = 'Fetching sellers...';
            const assetName = document.getElementById('mt-blast-selected-name').textContent;
            mtLog('Fetching sellers of "' + assetName + '"...', 'info');
            try {
                const myUid = await getMyUserId();
                const owners = await fetchAssetOwners(blastState.targetAssetId);
                blastState.targetOwners = owners.filter(o => o.userId !== myUid);
                document.getElementById('mt-blast-owner-count').textContent = blastState.targetOwners.length + ' sellers found';
                mtLog('Found ' + blastState.targetOwners.length + ' sellers', 'ok');
                updateBlastSummary();
            } catch(e) {
                mtLog('Error: ' + e.message, 'err');
            }
            btn.disabled = false; btn.textContent = 'Find Sellers';
        });

        // ── Send button ───────────────────────────────────────────────────
        panel.querySelector('#mt-blast-btn').addEventListener('click', () => {
            if (!blastState.mySelected.length) { mtLog('Select items to offer first', 'err'); return; }
            if (!blastState.targetOwners.length) { mtLog('Find sellers first', 'err'); return; }
            const maxSend = blastState.maxSendCount;
            const sendCount = maxSend ? Math.min(maxSend, blastState.targetOwners.length) : blastState.targetOwners.length;
            const msg = 'Send trade to ' + sendCount + ' seller' + (sendCount > 1 ? 's' : '') + '?\n\nYou will offer ' + blastState.mySelected.length + ' item(s).' + (sendCount > 85 ? '\n\n⚠ Large blast — be careful!' : '');
            showConfirm(msg, doBlast);
        });

        // ── Stop button ───────────────────────────────────────────────────
        panel.querySelector('#mt-blast-stop-btn').addEventListener('click', () => {
            blastState.stopped = true;
            mtLog('Stop requested...', 'info');
        });

        // ── Max users controls ────────────────────────────────────────────
        const display = document.getElementById('mt-max-display');
        function updateMaxDisplay() { display.textContent = blastState.maxSendCount === null ? 'All' : blastState.maxSendCount; }
        panel.querySelector('#mt-max-dec').addEventListener('click', () => {
            if (blastState.maxSendCount === null) blastState.maxSendCount = blastState.targetOwners.length || 1;
            if (blastState.maxSendCount > 1) blastState.maxSendCount--;
            updateMaxDisplay();
        });
        panel.querySelector('#mt-max-inc').addEventListener('click', () => {
            const max = blastState.targetOwners.length;
            if (blastState.maxSendCount === null) blastState.maxSendCount = 1;
            else if (!max || blastState.maxSendCount < max) blastState.maxSendCount++;
            else blastState.maxSendCount++;
            updateMaxDisplay();
        });
        panel.querySelector('#mt-max-all').addEventListener('click', () => { blastState.maxSendCount = null; updateMaxDisplay(); });

        // ── Delay controls ────────────────────────────────────────────────
        const delayDisplay = document.getElementById('mt-delay-display');
        function updateDelayDisplay() {
            const s = blastState.delaySeconds;
            delayDisplay.textContent = s >= 60 ? (s / 60).toFixed(1).replace('.0', '') + ' min' : s + ' sec';
        }
        panel.querySelector('#mt-delay-dec').addEventListener('click', () => {
            if (blastState.delaySeconds > 5) {
                if (blastState.delaySeconds <= 60) blastState.delaySeconds -= 5;
                else if (blastState.delaySeconds <= 300) blastState.delaySeconds -= 30;
                else blastState.delaySeconds -= 60;
                updateDelayDisplay();
            }
        });
        panel.querySelector('#mt-delay-inc').addEventListener('click', () => {
            if (blastState.delaySeconds < 1200) {
                if (blastState.delaySeconds < 60) blastState.delaySeconds += 5;
                else if (blastState.delaySeconds < 300) blastState.delaySeconds += 30;
                else blastState.delaySeconds += 60;
                updateDelayDisplay();
            }
        });

        updateMaxDisplay();
        updateDelayDisplay();

        // Restore logs if panel was reopened
        const log = document.getElementById('mt-blast-log');
        if (log && blastState.logs.length) {
            for (const entry of blastState.logs) {
                const d = document.createElement('div');
                d.className = 'mt-log-item mt-log-' + entry.type;
                d.textContent = entry.msg;
                log.appendChild(d);
            }
            log.scrollTop = log.scrollHeight;
        }
    }

    // ─── Render my items grid ─────────────────────────────────────────────────
    function renderBlastMyGrid() {
        const wrap = document.getElementById('mt-blast-my-items');
        if (!wrap) return;
        if (!blastState.myItems.length) { wrap.innerHTML = '<div class="mt-placeholder">No items</div>'; return; }
        wrap.innerHTML = '';
        const grid = document.createElement('div');
        grid.className = 'mt-items-grid';
        for (const item of blastState.myItems) {
            const k = getKoromons(item.assetId);
            const thumb = assetThumbs[item.assetId] || ITEM_FB;
            const name  = item.name || 'Asset ' + item.assetId;
            const isSel   = blastState.mySelected.some(s => s.userAssetId === item.userAssetId);
            const isMaxed = blastState.mySelected.length >= MAX_SELECT && !isSel;
            const card = document.createElement('div');
            card.className = 'mt-item-card' + (isSel ? ' mt-item-sel' : '') + (isMaxed ? ' mt-item-maxed' : '');
            let tags = '';
            if (k) {
                if (k.value) tags += '<span class="mt-tag mt-tag-v">' + (k.value||0).toLocaleString() + '</span>';
                if (k.rap)   tags += '<span class="mt-tag mt-tag-r">' + (k.rap||0).toLocaleString() + '</span>';
            }
            card.innerHTML =
                '<div class="mt-item-img-wrap"><img src="' + thumb + '" onerror="this.src=\'' + ITEM_FB + '\'"></div>' +
                '<div class="mt-item-name" title="' + esc(name) + '">' + esc(name) + '</div>' +
                (tags ? '<div class="mt-item-tags">' + tags + '</div>' : '');
            if (!isMaxed) {
                card.addEventListener('click', () => {
                    const idx = blastState.mySelected.findIndex(s => s.userAssetId === item.userAssetId);
                    if (idx >= 0) blastState.mySelected.splice(idx, 1);
                    else if (blastState.mySelected.length < MAX_SELECT) blastState.mySelected.push(item);
                    renderBlastMyGrid();
                    updateBlastSummary();
                    updateMassTradeTotal();
                });
            }
            grid.appendChild(card);
        }
        wrap.appendChild(grid);
        const cnt = document.getElementById('mt-blast-my-count');
        if (cnt) cnt.textContent = '(' + blastState.mySelected.length + '/' + MAX_SELECT + ')';
    }

    function updateBlastSummary() {
        const el  = document.getElementById('mt-blast-summary');
        const btn = document.getElementById('mt-blast-btn');
        if (!el) return;
        if (blastState.targetOwners.length && blastState.targetAssetId) {
            el.style.display = 'block';
            const myVal = blastState.mySelected.reduce((s, i) => s + ((koromonsItems[i.assetId]||{}).value||0), 0);
            el.innerHTML =
                '<b style="color:#f0e0c0">' + blastState.targetOwners.length + '</b> sellers will receive a trade<br>' +
                'Offering: <b style="color:#c8944a">' + (blastState.mySelected.length ? blastState.mySelected.map(i => i.name || 'item').join(', ') : 'nothing selected') + '</b>' +
                (myVal ? ' (Value: ' + myVal.toLocaleString() + ')' : '');
        } else {
            el.style.display = 'none';
        }
        if (btn) btn.disabled = !blastState.mySelected.length || !blastState.targetOwners.length;
    }

    // ─── Main blast loop ──────────────────────────────────────────────────────
    async function doBlast() {
        if (blastState.sending) return;
        blastState.sending = true;
        blastState.stopped = false;

        const blastBtn   = document.getElementById('mt-blast-btn');
        const stopBtn    = document.getElementById('mt-blast-stop-btn');
        const progress   = document.getElementById('mt-blast-progress');
        const progressBar = document.getElementById('mt-blast-progress-bar');

        if (blastBtn)  blastBtn.style.display = 'none';
        if (stopBtn)   stopBtn.style.display  = '';
        if (progress)  progress.style.display = 'block';

        const myUid    = await getMyUserId();
        const allOwners = blastState.targetOwners;
        const maxSend  = blastState.maxSendCount;
        const owners   = maxSend ? allOwners.slice(0, maxSend) : allOwners;
        let sent = 0, failed = 0, skipped = 0;

        mtLog('Blasting to ' + owners.length + ' sellers...', 'info');

        for (let i = 0; i < owners.length; i++) {
            if (blastState.stopped) {
                mtLog('⏹ Stopped. Sent: ' + sent + ' | Failed: ' + failed + ' | Skipped: ' + skipped, 'info');
                break;
            }

            const owner = owners[i];
            if (progressBar) progressBar.style.width = Math.round((i / owners.length) * 100) + '%';

            try {
                await apiPost(EP_TRADE_SEND, {
                    offers: [
                        { userId: myUid, userAssetIds: blastState.mySelected.map(x => x.userAssetId) },
                        { userId: owner.userId, userAssetIds: [owner.userAssetId] }
                    ]
                });
                sent++;
                mtLog('✓ [' + (i+1) + '/' + owners.length + '] ' + owner.username, 'ok');
            } catch(e) {
                const msg = (e.message || '').toLowerCase();
                if (msg.includes('already') || msg.includes('pending') || msg.includes('429') || msg.includes('flood')) {
                    skipped++;
                    mtLog('⚠ [' + (i+1) + '/' + owners.length + '] Skipped ' + owner.username + ' (already pending)', 'info');
                } else {
                    failed++;
                    mtLog('✗ [' + (i+1) + '/' + owners.length + '] ' + owner.username + ': ' + e.message, 'err');
                }
            }

            if (i < owners.length - 1 && !blastState.stopped) {
                await new Promise(r => setTimeout(r, blastState.delaySeconds * 1000));
            }
        }

        if (progressBar) progressBar.style.width = '100%';
        mtLog('✅ Done! Sent: ' + sent + ' | Failed: ' + failed + ' | Skipped: ' + skipped, 'ok');

        blastState.sending = false;
        if (blastBtn) { blastBtn.style.display = ''; blastBtn.disabled = false; }
        if (stopBtn)  stopBtn.style.display = 'none';
    }

    function closeMassTradePanel() {
        document.getElementById('mass-trade-ov')?.remove();
        document.getElementById('mass-trade-panel')?.remove();
    }

    function mtLog(msg, type) {
        blastState.logs.push({ msg, type: type || 'info' });
        const log = document.getElementById('mt-blast-log');
        if (!log) return;
        const d = document.createElement('div');
        d.className = 'mt-log-item mt-log-' + (type || 'info');
        d.textContent = msg;
        log.appendChild(d);
        log.scrollTop = log.scrollHeight;
    }

    // ─── FAB button ───────────────────────────────────────────────────────────
    function injectFab() {
        if (document.getElementById('mts-fab')) return;
        const fab = document.createElement('button');
        fab.id = 'mts-fab';
        fab.title = 'Mass Trade Sender';
        fab.textContent = '⇄';
        fab.addEventListener('click', () => {
            injectCss();
            showMassTradePanel();
        });
        document.body.appendChild(fab);
    }

    // ─── Boot ─────────────────────────────────────────────────────────────────
    async function init() {
        await seedCsrf();
        injectFab();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

})();
