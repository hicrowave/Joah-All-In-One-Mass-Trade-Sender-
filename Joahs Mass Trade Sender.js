// ==UserScript==
// @name         Joahs Mass Trade Sender
// @namespace    https://tampermonkey.net/
// @version      1.2
// @description  Send trades to owners of specific items. Smart Target finds users who own multiple items :P
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

    const BASE           = 'https://www.pekora.zip';
    const EP_KOROMONS    = 'https://koromons.lol/api/items';
    const EP_INVENTORY   = BASE + '/apisite/inventory/v1/users/{uid}/assets/collectibles';
    const EP_ASSET_THUMB = BASE + '/apisite/thumbnails/v1/assets';
    const EP_TRADE_SEND  = BASE + '/apisite/trades/v1/trades/send';
    const MAX_SELECT     = 8;
    const ICON_URL       = 'https://files.catbox.moe/btg1zy.png';

    let iconDataUrl = ''; // populated at init via GM_xmlhttpRequest (bypasses CSP)

    function fetchIcon() {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: ICON_URL,
                responseType: 'arraybuffer',
                onload(r) {
                    try {
                        const bytes = new Uint8Array(r.response);
                        let bin = '';
                        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
                        iconDataUrl = 'data:image/png;base64,' + btoa(bin);
                    } catch {}
                    resolve();
                },
                onerror() { resolve(); }
            });
        });
    }

    function iconImg(size) {
        return iconDataUrl
            ? '<img src="' + iconDataUrl + '" style="width:' + size + 'px;height:' + size + 'px;object-fit:contain;">'
            : '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
    }

    let koromonsItems = {};
    let assetThumbs   = {};
    let assetValues   = {};
    let csrfToken     = null;

    // Blast tab state (send to all owners of one item)
    let blastState = {
        myUserId: null,
        myItems: [], mySelected: [],
        targetAssetId: null, targetOwners: [],
        sending: false, stopped: false,
        maxSendCount: null, logs: [],
        delaySeconds: 20
    };

    // Smart Target tab state (find users who own multiple items)
    let smartState = {
        targetList: [],       // [{ assetId, name, thumb }] — can have duplicates
        matchedOwners: [],    // [{ userId, username, userAssetIds: [] }]
        mySelected: [],
        sending: false, stopped: false,
        maxSendCount: null, logs: [],
        delaySeconds: 20
    };

    const ITEM_FB = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3Crect fill='%23252525' width='1' height='1'/%3E%3C/svg%3E";

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
                        m[itemId] = { assetId: itemId, name: it.Name || it.name, value, rap: value };
                    }
                }
                koromonsItems = m;
            }
        } catch {}
    }

    function getKoromons(id) { return koromonsItems[id] || null; }

    async function fetchAssetThumbs(assetIds) {
        if (!assetIds.length) return;
        const needed = assetIds.filter(id => !assetThumbs[id]);
        for (let i = 0; i < needed.length; i += 30) {
            const chunk = needed.slice(i, i + 30);
            try {
                const j = await apiGet(EP_ASSET_THUMB + '?assetIds=' + chunk.join(',') + '&format=png&size=420x420', true);
                if (Array.isArray(j.data))
                    for (const e of j.data)
                        if (e.state === 'Completed' && e.imageUrl)
                            assetThumbs[e.targetId] = e.imageUrl.startsWith('http') ? e.imageUrl : BASE + e.imageUrl;
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

    // Fetches ALL owners of an asset. Returns [{ userId, username, userAssetId }]
    // Tries the full inventory owners endpoint first, falls back to resellers.
    async function fetchAssetOwners(assetId, logFn) {
        const log = logFn || (() => {});
        const owners = [];
        let cursor = '', pages = 0, useResellers = false;

        try {
            const test = await apiGet(BASE + '/apisite/inventory/v2/assets/' + assetId + '/owners?limit=1', true);
            if (!test || (!test.data && !test.nextPageCursor)) useResellers = true;
        } catch { useResellers = true; }

        log(useResellers ? '⚠ Using resellers endpoint (sellers only)' : '✓ Using owners endpoint (all owners)', 'info');

        while (pages < 200) {
            pages++;
            let url = useResellers
                ? BASE + '/apisite/economy/v1/assets/' + assetId + '/resellers?limit=100'
                : BASE + '/apisite/inventory/v2/assets/' + assetId + '/owners?limit=100';
            if (cursor) url += '&cursor=' + encodeURIComponent(cursor);
            try {
                const j = await apiGet(url, true);
                for (const e of (j.data || [])) {
                    let userId, username, userAssetId;
                    if (useResellers) {
                        const s = e.seller || {};
                        userId = s.id || s.userId; username = s.name || s.displayName || ('User #' + userId); userAssetId = e.userAssetId;
                    } else {
                        const o = e.owner || e.user || e;
                        userId = o.id || o.userId; username = o.displayName || o.name || ('User #' + userId); userAssetId = e.userAssetId || e.id;
                    }
                    if (userId && userAssetId) owners.push({ userId, username, userAssetId });
                }
                if (j.nextPageCursor) cursor = j.nextPageCursor; else break;
            } catch (e) { console.error('[MTS] page ' + pages + ':', e); break; }
        }
        return owners;
    }

    // ─── Smart Target — find intersection of owners ───────────────────────────
    // targetList = [{ assetId }, { assetId }, ...] — duplicates allowed (means "need N copies")
    // Returns [{ userId, username, userAssetIds: [id1, id2, ...] }]
    async function findIntersectedOwners(targetList, logFn) {
        const log = logFn || (() => {});

        // Count how many copies needed per assetId
        const requiredCopies = {};
        for (const t of targetList) {
            requiredCopies[t.assetId] = (requiredCopies[t.assetId] || 0) + 1;
        }

        const uniqueAssetIds = Object.keys(requiredCopies);
        log('Scanning ' + uniqueAssetIds.length + ' unique item(s)...', 'info');

        // For each unique assetId, fetch all owners
        // ownersMap[assetId] = [{ userId, username, userAssetId }, ...]
        const ownersMap = {};
        for (const assetId of uniqueAssetIds) {
            log('Fetching owners of asset ' + assetId + '...', 'info');
            const owners = await fetchAssetOwners(assetId, log);
            ownersMap[assetId] = owners;
            log('→ ' + owners.length + ' owners found for ' + assetId, 'ok');
        }

        // Build per-user ownership map
        // userOwnership[userId] = { username, copies: { assetId: [userAssetId, ...] } }
        const userOwnership = {};
        for (const assetId of uniqueAssetIds) {
            for (const entry of ownersMap[assetId]) {
                const uid = entry.userId;
                if (!userOwnership[uid]) userOwnership[uid] = { username: entry.username, copies: {} };
                if (!userOwnership[uid].copies[assetId]) userOwnership[uid].copies[assetId] = [];
                userOwnership[uid].copies[assetId].push(entry.userAssetId);
            }
        }

        // Filter: user must own at least requiredCopies[assetId] copies of each assetId
        const matched = [];
        const myUid = await getMyUserId();

        for (const [uid, data] of Object.entries(userOwnership)) {
            if (parseInt(uid) === myUid) continue; // skip yourself

            let qualifies = true;
            const tradeUserAssetIds = []; // the userAssetIds we'll request from them

            for (const assetId of uniqueAssetIds) {
                const required = requiredCopies[assetId];
                const owned    = (data.copies[assetId] || []).length;
                if (owned < required) { qualifies = false; break; }
                // Pick exactly `required` copies to include in the trade
                for (let i = 0; i < required; i++) {
                    tradeUserAssetIds.push(data.copies[assetId][i]);
                }
            }

            if (qualifies) {
                matched.push({
                    userId: parseInt(uid),
                    username: data.username,
                    userAssetIds: tradeUserAssetIds
                });
            }
        }

        return matched;
    }

    function updateMassTradeTotal(selectedItems, rapId, valueId) {
        const rapEl   = document.getElementById(rapId);
        const valueEl = document.getElementById(valueId);
        if (!rapEl || !valueEl) return;
        let totalRap = 0, totalValue = 0;
        for (const item of selectedItems) {
            totalRap   += item.recentAveragePrice || 0;
            totalValue += (getKoromons(item.assetId) || {}).value || 0;
        }
        rapEl.textContent   = totalRap.toLocaleString();
        valueEl.textContent = totalValue.toLocaleString();
    }

    function showConfirm(msg, onYes) {
        const old = document.getElementById('mts-tc'); if (old) old.remove();
        const ov = document.createElement('div');
        ov.id = 'mts-tc';
        ov.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.75);z-index:1000000000;display:flex;align-items:center;justify-content:center';
        const box = document.createElement('div');
        box.style.cssText = 'background:#2b2d2f;border:1px solid #393b3d;padding:24px 28px;max-width:420px;width:90%;font-family:"Gotham SSm","Gotham",sans-serif;color:#fff;box-shadow:0 8px 32px rgba(0,0,0,.6)';
        box.innerHTML =
            '<div style="font-size:14px;font-weight:700;margin-bottom:6px">Confirm Action</div>' +
            '<div style="font-size:12px;color:#b8b8b8;margin-bottom:20px;white-space:pre-wrap">' + esc(msg) + '</div>' +
            '<div style="display:flex;gap:10px;justify-content:flex-end">' +
            '<button id="mts-tc-no"  style="padding:8px 20px;border:1px solid #393b3d;background:transparent;color:#b8b8b8;font-weight:700;font-size:12px;cursor:pointer;font-family:inherit">Cancel</button>' +
            '<button id="mts-tc-yes" style="padding:8px 20px;border:none;background:#8b5e2e;color:#fff;font-weight:800;font-size:12px;cursor:pointer;font-family:inherit">Confirm</button>' +
            '</div>';
        ov.appendChild(box);
        document.body.appendChild(ov);
        box.querySelector('#mts-tc-yes').addEventListener('click', () => { ov.remove(); onYes(); });
        box.querySelector('#mts-tc-no').addEventListener('click',  () => ov.remove());
        ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
    }

    // ─── CSS ──────────────────────────────────────────────────────────────────
    function injectCss() {
        if (document.getElementById('mts-style')) return;
        const s = document.createElement('style');
        s.id = 'mts-style';
        s.textContent =
'@keyframes mts-fi{from{opacity:0}to{opacity:1}}' +
'@keyframes mts-cpi{from{opacity:0;transform:translate(-50%,-50%) translateY(-16px)}to{opacity:1;transform:translate(-50%,-50%) translateY(0)}}' +

'#mts-fab{position:fixed;bottom:28px;right:28px;z-index:99998;width:50px;height:50px;background:#8b5e2e;color:#fff;border:none;cursor:pointer;font-size:20px;font-weight:900;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 18px rgba(139,94,46,.5);transition:transform .15s,box-shadow .15s,background .15s}' +
'#mts-fab:hover{transform:scale(1.1);background:#a06d38;box-shadow:0 6px 24px rgba(160,109,56,.6)}' +

'#mass-trade-ov{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.75);z-index:999998;animation:mts-fi .2s ease}' +
'#mass-trade-panel{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:740px;max-width:96vw;max-height:90vh;background:#1a1a1a;z-index:999999;display:flex;flex-direction:column;box-shadow:0 12px 48px rgba(0,0,0,.8);font-family:"Gotham SSm","Gotham",sans-serif;overflow:hidden;animation:mts-cpi .2s ease}' +

'.mt-h{display:flex;justify-content:space-between;align-items:center;padding:0 18px;height:52px;background:#8b5e2e;flex-shrink:0}' +
'.mt-hl{display:flex;align-items:center;gap:8px}' +
'.mt-title{font-size:15px;font-weight:800;color:#fff;letter-spacing:.2px;text-transform:uppercase}' +
'.mt-x{color:rgba(255,255,255,.6);font-size:22px;cursor:pointer;padding:4px 8px;font-weight:700;line-height:1;transition:all .15s}.mt-x:hover{color:#fff;background:rgba(255,255,255,.15)}' +

// Tabs
'.mt-tabs{display:flex;background:#111;border-bottom:2px solid #2b2d2f;flex-shrink:0}' +
'.mt-tab{flex:1;padding:10px;background:none;border:none;color:#888;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;border-bottom:3px solid transparent;margin-bottom:-2px;transition:all .15s;text-transform:uppercase;letter-spacing:.5px}' +
'.mt-tab:hover{color:#fff;background:rgba(255,255,255,.04)}' +
'.mt-tab.active{color:#c8944a;border-bottom-color:#8b5e2e;background:rgba(139,94,46,.08)}' +
'.mt-tab-content{display:none}.mt-tab-content.active{display:flex;flex-direction:column}' +

'.mt-body{padding:14px;overflow-y:auto;display:flex;flex-direction:column;gap:12px;max-height:calc(90vh - 100px)}' +
'.mt-body::-webkit-scrollbar{width:6px}.mt-body::-webkit-scrollbar-track{background:#111}.mt-body::-webkit-scrollbar-thumb{background:#393b3d}' +

'.mt-step{background:#232323;padding:14px;border:1px solid #2b2d2f}' +
'.mt-step-label{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.8px;color:#c8944a;margin-bottom:10px;display:flex;align-items:center;gap:6px}' +
'.mt-step-num{width:18px;height:18px;background:#8b5e2e;color:#fff;font-size:10px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}' +
'.mt-count{color:#fff;font-weight:700;background:#393b3d;padding:1px 6px;font-size:10px}' +

'.mt-row{display:flex;gap:8px;align-items:center}' +
'.mt-input{flex:1;height:36px;padding:0 12px;background:#111;border:1px solid #393b3d;color:#fff;font-size:13px;font-family:inherit;outline:none;transition:border-color .15s}.mt-input:focus{border-color:#8b5e2e}.mt-input::placeholder{color:#555}' +

'.mt-btn{padding:8px 16px;border:none;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .15s;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}' +
'.mt-btn:active{transform:scale(.97)}' +
'.mt-btn-blue{background:#8b5e2e;color:#fff}.mt-btn-blue:hover:not(:disabled){background:#a06d38}' +
'.mt-btn-blue:disabled{opacity:.4;cursor:not-allowed}' +
'.mt-btn-green{background:#00a152;color:#fff;width:100%;justify-content:center;padding:12px;font-size:14px;font-weight:800}.mt-btn-green:hover:not(:disabled){background:#00ba5e}' +
'.mt-btn-green:disabled{opacity:.35;cursor:not-allowed}' +
'.mt-btn-red{background:#cc3333;color:#fff}.mt-btn-red:hover{background:#e04444}' +
'.mt-btn-ghost{background:transparent;border:1px solid #393b3d;color:#888}.mt-btn-ghost:hover{border-color:#8b5e2e;color:#c8944a}' +
'.mt-fullw{width:100%;justify-content:center}' +
'.mt-small-btn{width:26px;height:26px;border:1px solid #393b3d;background:#111;color:#fff;font-size:14px;font-weight:700;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;justify-content:center}.mt-small-btn:hover{background:#8b5e2e;border-color:#8b5e2e}' +
'.mt-max-btn{padding:4px 10px;border:1px solid #393b3d;background:#111;color:#b8b8b8;font-size:10px;font-weight:700;cursor:pointer;transition:all .15s}.mt-max-btn:hover{background:#8b5e2e;border-color:#8b5e2e;color:#fff}' +

'.mt-placeholder{color:#555;text-align:center;padding:30px 0;font-size:12px}' +
'.mt-items-grid-wrap{max-height:200px;overflow-y:auto;margin-top:8px}.mt-items-grid-wrap::-webkit-scrollbar{width:5px}.mt-items-grid-wrap::-webkit-scrollbar-thumb{background:#393b3d}' +
'.mt-items-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(86px,1fr));gap:6px}' +
'.mt-item-card{background:#111;border:2px solid #2b2d2f;padding:6px;cursor:pointer;transition:all .15s;display:flex;flex-direction:column;align-items:center;gap:4px;position:relative}' +
'.mt-item-card:hover{border-color:#8b5e2e;transform:translateY(-2px);box-shadow:0 4px 12px rgba(139,94,46,.25)}' +
'.mt-item-card.mt-item-sel{border-color:#8b5e2e!important;background:#2a1a0a!important;box-shadow:0 0 0 1px #8b5e2e}' +
'.mt-item-card.mt-item-sel::after{content:"✓";position:absolute;top:4px;right:4px;width:14px;height:14px;background:#8b5e2e;font-size:9px;font-weight:800;color:#fff;display:flex;align-items:center;justify-content:center}' +
'.mt-item-card.mt-item-maxed{opacity:.2;cursor:not-allowed;pointer-events:none}' +
'.mt-item-img-wrap{width:66px;height:66px;background:#1a1a1a;overflow:hidden;flex-shrink:0}' +
'.mt-item-img-wrap img{width:100%;height:100%;object-fit:contain}' +
'.mt-item-name{font-size:9px;color:#e0e0e0;font-weight:600;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%}' +
'.mt-item-tags{display:flex;gap:2px;flex-wrap:wrap;justify-content:center}' +
'.mt-tag{font-size:8px;padding:1px 4px;font-weight:700}' +
'.mt-tag-v{background:rgba(139,94,46,.25);color:#c8944a}.mt-tag-r{background:rgba(0,161,82,.2);color:#66bb6a}' +

'.mt-blast-target-grid{margin-top:8px;max-height:230px;overflow-y:auto;background:#111;border:1px solid #2b2d2f;padding:8px}' +
'.mt-blast-target-grid::-webkit-scrollbar{width:5px}.mt-blast-target-grid::-webkit-scrollbar-thumb{background:#393b3d}' +

'.mt-selected-preview{margin-top:8px;padding:10px 12px;background:#111;border:1px solid #393b3d;display:flex;align-items:center;gap:10px}' +
'.mt-selected-preview img{width:50px;height:50px;object-fit:contain;background:#1a1a1a;flex-shrink:0}' +
'.mt-selected-name{font-size:13px;font-weight:700;color:#fff;margin-bottom:3px}' +
'.mt-selected-sub{font-size:11px;color:#888}' +

'.mt-blast-summary{background:#111;border:1px solid #2b2d2f;padding:10px 12px;font-size:12px;color:#b8b8b8;margin-bottom:8px}' +
'.mt-controls-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:12px;flex-wrap:wrap}' +
'.mt-control-group{display:flex;align-items:center;gap:6px}' +
'.mt-control-label{font-size:11px;color:#888;font-weight:600}' +
'.mt-control-val{font-size:12px;font-weight:700;color:#fff;min-width:55px;text-align:center}' +
'.mt-progress{height:4px;background:#111;overflow:hidden;margin-top:10px}' +
'.mt-progress-bar{height:100%;background:#8b5e2e;transition:width .3s;width:0%}' +
'.mt-log{max-height:110px;overflow-y:auto;margin-top:8px;display:flex;flex-direction:column;gap:3px}.mt-log::-webkit-scrollbar{width:3px}.mt-log::-webkit-scrollbar-thumb{background:#393b3d}' +
'.mt-log-item{font-size:11px;padding:4px 8px;font-weight:600;font-family:Consolas,monospace}' +
'.mt-log-info{background:#1a1a2a;color:#c8944a;border-left:2px solid #8b5e2e}' +
'.mt-log-ok{background:#1a2a1a;color:#66bb6a;border-left:2px solid #00a152}' +
'.mt-log-err{background:#2a1a1a;color:#ef5350;border-left:2px solid #cc3333}' +
'.mt-warn-banner{background:rgba(204,51,51,.12);border:1px solid rgba(204,51,51,.4);padding:8px 12px;font-size:11px;font-weight:700;color:#ef9a9a;text-align:center}' +
'.mt-stats-row{display:flex;gap:12px;font-size:12px;color:#888;padding:4px 0}' +
'.mt-stat-val{color:#c8944a;font-weight:700}' +

// Smart Target specific
'.st-target-list{display:flex;flex-direction:column;gap:6px;margin-top:8px;max-height:180px;overflow-y:auto}' +
'.st-target-list::-webkit-scrollbar{width:5px}.st-target-list::-webkit-scrollbar-thumb{background:#393b3d}' +
'.st-target-row{display:flex;align-items:center;gap:8px;padding:7px 10px;background:#111;border:1px solid #2b2d2f}' +
'.st-target-thumb{width:36px;height:36px;object-fit:contain;background:#1a1a1a;flex-shrink:0}' +
'.st-target-name{flex:1;font-size:11px;font-weight:600;color:#e0e0e0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
'.st-target-id{font-size:10px;color:#555;margin-top:1px}' +
'.st-copy-badge{background:#8b5e2e;color:#fff;font-size:10px;font-weight:700;padding:2px 6px;flex-shrink:0}' +
'.st-remove-btn{background:none;border:none;color:#555;font-size:16px;cursor:pointer;padding:0 4px;line-height:1;transition:color .15s}.st-remove-btn:hover{color:#ef5350}' +
'.st-matched-list{display:flex;flex-direction:column;gap:4px;margin-top:8px;max-height:150px;overflow-y:auto}' +
'.st-matched-list::-webkit-scrollbar{width:5px}.st-matched-list::-webkit-scrollbar-thumb{background:#393b3d}' +
'.st-matched-row{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:#111;border:1px solid #2b2d2f;font-size:12px;color:#e0e0e0}' +
'.st-matched-uid{font-size:10px;color:#555;margin-top:1px}' +
'.st-items-badge{font-size:10px;color:#c8944a;font-weight:700;background:rgba(139,94,46,.15);padding:2px 6px}' +
'.st-empty{color:#555;text-align:center;padding:20px 0;font-size:12px}' +
'.st-info-box{background:#2a1a0a;border:1px solid #8b5e2e;padding:10px 12px;font-size:11px;color:#c8944a;line-height:1.6}';

        document.head.appendChild(s);
    }

    // ─── Shared target grid renderer (used by both tabs) ─────────────────────
    let allTargetItems = [];

    function renderTargetGrid(containerId, items, onSelect) {
        const grid = document.getElementById(containerId);
        if (!grid) return;
        if (!items.length) { grid.innerHTML = '<div style="padding:16px;color:#555;text-align:center;font-size:12px">No items found</div>'; return; }
        grid.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(86px,1fr));gap:6px"></div>';
        const container = grid.querySelector('div');
        for (const item of items) {
            const thumb = assetThumbs[item.assetId] || ITEM_FB;
            const card = document.createElement('div');
            card.style.cssText = 'background:#1a1a1a;border:2px solid transparent;padding:6px;cursor:pointer;transition:all .15s;display:flex;flex-direction:column;align-items:center;gap:4px';
            card.innerHTML =
                '<img src="' + thumb + '" style="width:66px;height:66px;object-fit:contain;background:#111">' +
                '<div style="font-size:9px;font-weight:600;color:#e0e0e0;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%">' + esc(item.name) + '</div>' +
                '<div style="font-size:8px;color:#c8944a;font-weight:700">' + (item.value || 0).toLocaleString() + '</div>';
            card.addEventListener('mouseenter', () => { card.style.borderColor = '#8b5e2e'; card.style.background = '#2a1a0a'; });
            card.addEventListener('mouseleave', () => { card.style.borderColor = 'transparent'; card.style.background = '#1a1a1a'; });
            card.addEventListener('click', () => onSelect(item, thumb));
            container.appendChild(card);
        }
    }

    // ─── Main panel ───────────────────────────────────────────────────────────
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
                '<div class="mt-hl">' + iconImg(28) + '<span class="mt-title">Joahs Mass Trade Sender</span></div>' +
                '<span class="mt-x">&#10005;</span>' +
            '</div>' +

            '<div class="mt-tabs">' +
                '<button class="mt-tab active" data-tab="blast">Blast All Owners</button>' +
                '<button class="mt-tab" data-tab="smart">Smart Target</button>' +
            '</div>' +

            // ── TAB: BLAST ─────────────────────────────────────────────────
            '<div class="mt-tab-content active" data-tab="blast">' +
            '<div class="mt-body" id="mt-blast-body">' +
                '<div class="mt-warn-banner">⚠ Abusing trades may result in a ban. Use responsibly.</div>' +
                '<div class="mt-step">' +
                    '<div class="mt-step-label"><span class="mt-step-num">1</span> Your Items to Offer <span class="mt-count" id="mt-blast-my-count">0/' + MAX_SELECT + '</span></div>' +
                    '<button class="mt-btn mt-btn-blue mt-fullw" id="mt-blast-load-inv">Load My Inventory</button>' +
                    '<div id="mt-blast-my-items" class="mt-items-grid-wrap"><div class="mt-placeholder">Click above to load your inventory</div></div>' +
                    '<div class="mt-stats-row">RAP: <span class="mt-stat-val" id="mt-blast-rap">0</span>&nbsp;&nbsp;Value: <span class="mt-stat-val" id="mt-blast-value">0</span></div>' +
                '</div>' +
                '<div class="mt-step">' +
                    '<div class="mt-step-label"><span class="mt-step-num">2</span> Target Item</div>' +
                    '<input id="mt-blast-search" class="mt-input" placeholder="Search by name or asset ID...">' +
                    '<div id="mt-blast-target-grid" class="mt-blast-target-grid"><div style="padding:16px;color:#555;text-align:center;font-size:12px">Loading collectibles...</div></div>' +
                    '<div id="mt-blast-selected-item" style="display:none" class="mt-selected-preview">' +
                        '<img id="mt-blast-selected-thumb" src="">' +
                        '<div style="flex:1"><div class="mt-selected-name" id="mt-blast-selected-name"></div><div class="mt-selected-sub" id="mt-blast-owner-count">Click "Find Owners"</div></div>' +
                        '<button class="mt-btn mt-btn-blue" id="mt-blast-find-owners">Find Owners</button>' +
                    '</div>' +
                '</div>' +
                '<div class="mt-step">' +
                    '<div class="mt-step-label"><span class="mt-step-num">3</span> Send Trades</div>' +
                    '<div id="mt-blast-summary" class="mt-blast-summary" style="display:none"></div>' +
                    '<div class="mt-controls-row">' +
                        '<div class="mt-control-group"><span class="mt-control-label">Max users</span><button class="mt-small-btn" id="mt-blast-max-dec">−</button><span class="mt-control-val" id="mt-blast-max-display">All</span><button class="mt-small-btn" id="mt-blast-max-inc">+</button><button class="mt-max-btn" id="mt-blast-max-all">All</button></div>' +
                        '<div class="mt-control-group"><span class="mt-control-label">Delay</span><button class="mt-small-btn" id="mt-blast-delay-dec">−</button><span class="mt-control-val" id="mt-blast-delay-display">20s</span><button class="mt-small-btn" id="mt-blast-delay-inc">+</button></div>' +
                    '</div>' +
                    '<div style="display:flex;gap:8px"><button class="mt-btn mt-btn-green" id="mt-blast-btn" disabled>Send All Trades</button><button class="mt-btn mt-btn-red" id="mt-blast-stop-btn" style="display:none">Stop</button></div>' +
                    '<div class="mt-progress" id="mt-blast-progress" style="display:none"><div class="mt-progress-bar" id="mt-blast-progress-bar"></div></div>' +
                    '<div class="mt-log" id="mt-blast-log"></div>' +
                '</div>' +
            '</div>' +
            '</div>' +

            // ── TAB: SMART TARGET ──────────────────────────────────────────
            '<div class="mt-tab-content" data-tab="smart">' +
            '<div class="mt-body" id="mt-smart-body">' +
                '<div class="mt-warn-banner">⚠ Abusing trades may result in a ban. Use responsibly.</div>' +
                '<div class="st-info-box">Pick multiple items below. The scanner will find users who own <b>all of them</b>. Add the same item more than once to require multiple copies. Trades will request all selected items from each matched user.</div>' +
                '<div class="mt-step">' +
                    '<div class="mt-step-label"><span class="mt-step-num">1</span> Your Items to Offer <span class="mt-count" id="mt-smart-my-count">0/' + MAX_SELECT + '</span></div>' +
                    '<button class="mt-btn mt-btn-blue mt-fullw" id="mt-smart-load-inv">Load My Inventory</button>' +
                    '<div id="mt-smart-my-items" class="mt-items-grid-wrap"><div class="mt-placeholder">Click above to load your inventory</div></div>' +
                    '<div class="mt-stats-row">RAP: <span class="mt-stat-val" id="mt-smart-rap">0</span>&nbsp;&nbsp;Value: <span class="mt-stat-val" id="mt-smart-value">0</span></div>' +
                '</div>' +
                '<div class="mt-step">' +
                    '<div class="mt-step-label"><span class="mt-step-num">2</span> Target Items <span class="mt-count" id="mt-smart-target-count">0 items</span></div>' +
                    '<input id="mt-smart-search" class="mt-input" placeholder="Search to add items...">' +
                    '<div id="mt-smart-picker-grid" class="mt-blast-target-grid"><div style="padding:16px;color:#555;text-align:center;font-size:12px">Loading collectibles...</div></div>' +
                    '<div id="mt-smart-target-list" class="st-target-list"></div>' +
                    '<div style="margin-top:8px;display:flex;gap:8px">' +
                        '<button class="mt-btn mt-btn-blue" id="mt-smart-scan-btn" disabled>Scan Owners</button>' +
                        '<button class="mt-btn mt-btn-ghost" id="mt-smart-clear-btn">Clear All</button>' +
                    '</div>' +
                '</div>' +
                '<div class="mt-step">' +
                    '<div class="mt-step-label"><span class="mt-step-num">3</span> Matched Users <span class="mt-count" id="mt-smart-match-count">0 found</span></div>' +
                    '<div id="mt-smart-matched-list" class="st-matched-list"><div class="st-empty">Run a scan first</div></div>' +
                '</div>' +
                '<div class="mt-step">' +
                    '<div class="mt-step-label"><span class="mt-step-num">4</span> Send Trades</div>' +
                    '<div id="mt-smart-summary" class="mt-blast-summary" style="display:none"></div>' +
                    '<div class="mt-controls-row">' +
                        '<div class="mt-control-group"><span class="mt-control-label">Max users</span><button class="mt-small-btn" id="mt-smart-max-dec">−</button><span class="mt-control-val" id="mt-smart-max-display">All</span><button class="mt-small-btn" id="mt-smart-max-inc">+</button><button class="mt-max-btn" id="mt-smart-max-all">All</button></div>' +
                        '<div class="mt-control-group"><span class="mt-control-label">Delay</span><button class="mt-small-btn" id="mt-smart-delay-dec">−</button><span class="mt-control-val" id="mt-smart-delay-display">20s</span><button class="mt-small-btn" id="mt-smart-delay-inc">+</button></div>' +
                    '</div>' +
                    '<div style="display:flex;gap:8px"><button class="mt-btn mt-btn-green" id="mt-smart-send-btn" disabled>Send to Matched Users</button><button class="mt-btn mt-btn-red" id="mt-smart-stop-btn" style="display:none">Stop</button></div>' +
                    '<div class="mt-progress" id="mt-smart-progress" style="display:none"><div class="mt-progress-bar" id="mt-smart-progress-bar"></div></div>' +
                    '<div class="mt-log" id="mt-smart-log"></div>' +
                '</div>' +
            '</div>' +
            '</div>';

        document.body.appendChild(panel);

        panel.querySelector('.mt-x').addEventListener('click', closeMassTradePanel);

        // Tab switching
        panel.querySelectorAll('.mt-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                panel.querySelectorAll('.mt-tab').forEach(t => t.classList.remove('active'));
                panel.querySelectorAll('.mt-tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                panel.querySelector('.mt-tab-content[data-tab="' + tab.dataset.tab + '"]').classList.add('active');
            });
        });

        // ── Load collectibles (shared) ────────────────────────────────────
        (async () => {
            if (!Object.keys(koromonsItems).length) await fetchKoromons();

            if (!Object.keys(koromonsItems).length) {
                const errMsg = '<div style="padding:16px;color:#ef5350;text-align:center;font-size:12px">⚠ Koromons API unavailable. Reload and try again.</div>';
                document.getElementById('mt-blast-target-grid').innerHTML = errMsg;
                document.getElementById('mt-smart-picker-grid').innerHTML = errMsg;
                mtBlastLog('Koromons API failed — no items loaded. Reload and try again.', 'err');
                mtSmartLog('Koromons API failed — no items loaded. Reload and try again.', 'err');
                return;
            }

            const collectibles = Object.values(koromonsItems).sort((a, b) => (b.value||0) - (a.value||0));
            allTargetItems = collectibles;
            await fetchAssetThumbs(collectibles.map(i => i.assetId));

            // Blast tab grid
            renderTargetGrid('mt-blast-target-grid', allTargetItems, (item, thumb) => {
                blastState.targetAssetId = item.assetId;
                document.getElementById('mt-blast-selected-thumb').src = thumb;
                document.getElementById('mt-blast-selected-name').textContent = item.name;
                document.getElementById('mt-blast-selected-item').style.display = 'flex';
                document.getElementById('mt-blast-owner-count').textContent = 'Click "Find Owners"';
                mtBlastLog('Selected: ' + item.name, 'info');
            });

            // Smart tab grid
            renderTargetGrid('mt-smart-picker-grid', allTargetItems, (item, thumb) => {
                smartState.targetList.push({ assetId: item.assetId, name: item.name, thumb });
                renderSmartTargetList();
            });

            mtBlastLog('Loaded ' + allTargetItems.length + ' items', 'ok');
            mtSmartLog('Loaded ' + allTargetItems.length + ' items', 'ok');
        })();

        // Blast search
        panel.querySelector('#mt-blast-search').addEventListener('input', e => {
            const q = e.target.value.toLowerCase();
            renderTargetGrid('mt-blast-target-grid', q ? allTargetItems.filter(i => (i.name||'').toLowerCase().includes(q) || String(i.assetId).includes(q)) : allTargetItems, (item, thumb) => {
                blastState.targetAssetId = item.assetId;
                document.getElementById('mt-blast-selected-thumb').src = thumb;
                document.getElementById('mt-blast-selected-name').textContent = item.name;
                document.getElementById('mt-blast-selected-item').style.display = 'flex';
                document.getElementById('mt-blast-owner-count').textContent = 'Click "Find Owners"';
            });
        });

        // Smart search
        panel.querySelector('#mt-smart-search').addEventListener('input', e => {
            const q = e.target.value.toLowerCase();
            renderTargetGrid('mt-smart-picker-grid', q ? allTargetItems.filter(i => (i.name||'').toLowerCase().includes(q) || String(i.assetId).includes(q)) : allTargetItems, (item, thumb) => {
                smartState.targetList.push({ assetId: item.assetId, name: item.name, thumb });
                renderSmartTargetList();
            });
        });

        // ── BLAST TAB — inventory ─────────────────────────────────────────
        const bindInventoryLoad = (btnId, myItemsId, myCountId, rapId, valueId, selectedArr, onLoaded) => {
            panel.querySelector('#' + btnId).addEventListener('click', async () => {
                const btn = panel.querySelector('#' + btnId);
                btn.disabled = true; btn.textContent = 'Loading...';
                try {
                    const myUid = await getMyUserId();
                    if (!myUid) { btn.disabled = false; btn.textContent = 'Load My Inventory'; return; }
                    if (!Object.keys(koromonsItems).length) await fetchKoromons();
                    const items = await fetchInventory(myUid);
                    await fetchAssetThumbs([...new Set(items.map(i => i.assetId).filter(Boolean))]);
                    onLoaded(items);
                    btn.textContent = '✓ Loaded (' + items.length + ')';
                } catch(e) { btn.disabled = false; btn.textContent = 'Load My Inventory'; }
            });
        };

        bindInventoryLoad('mt-blast-load-inv', 'mt-blast-my-items', 'mt-blast-my-count', 'mt-blast-rap', 'mt-blast-value', blastState.mySelected, items => {
            blastState.myItems = items; blastState.mySelected = [];
            renderBlastMyGrid();
        });

        bindInventoryLoad('mt-smart-load-inv', 'mt-smart-my-items', 'mt-smart-my-count', 'mt-smart-rap', 'mt-smart-value', smartState.mySelected, items => {
            blastState.myItems = items; smartState.mySelected = [];
            renderSmartMyGrid();
        });

        // ── BLAST TAB — find owners ───────────────────────────────────────
        panel.querySelector('#mt-blast-find-owners').addEventListener('click', async () => {
            if (!blastState.targetAssetId) return;
            const btn = panel.querySelector('#mt-blast-find-owners');
            btn.disabled = true; btn.textContent = 'Finding...';
            document.getElementById('mt-blast-owner-count').textContent = 'Fetching owners...';
            try {
                const myUid = await getMyUserId();
                const owners = await fetchAssetOwners(blastState.targetAssetId, mtBlastLog);
                blastState.targetOwners = owners.filter(o => o.userId !== myUid);
                document.getElementById('mt-blast-owner-count').textContent = blastState.targetOwners.length + ' owners found';
                mtBlastLog('Found ' + blastState.targetOwners.length + ' owners', 'ok');
                updateBlastSummary();
            } catch(e) { mtBlastLog('Error: ' + e.message, 'err'); }
            btn.disabled = false; btn.textContent = 'Find Owners';
        });

        // ── BLAST TAB — send ──────────────────────────────────────────────
        panel.querySelector('#mt-blast-btn').addEventListener('click', () => {
            if (!blastState.mySelected.length || !blastState.targetOwners.length) return;
            const count = blastState.maxSendCount ? Math.min(blastState.maxSendCount, blastState.targetOwners.length) : blastState.targetOwners.length;
            showConfirm('Send trade to ' + count + ' owner(s)?\n\nOffering: ' + blastState.mySelected.map(i => i.name||'item').join(', '), () => doBlast(blastState, 'mt-blast'));
        });
        panel.querySelector('#mt-blast-stop-btn').addEventListener('click', () => { blastState.stopped = true; mtBlastLog('Stop requested...', 'info'); });
        bindDelayControls('mt-blast-delay-dec', 'mt-blast-delay-inc', 'mt-blast-delay-display', blastState);
        bindMaxControls('mt-blast-max-dec', 'mt-blast-max-inc', 'mt-blast-max-all', 'mt-blast-max-display', blastState);

        // ── SMART TAB — scan ─────────────────────────────────────────────
        panel.querySelector('#mt-smart-scan-btn').addEventListener('click', async () => {
            if (!smartState.targetList.length) return;
            const btn = panel.querySelector('#mt-smart-scan-btn');
            btn.disabled = true; btn.textContent = 'Scanning...';
            const matchedEl = document.getElementById('mt-smart-matched-list');
            matchedEl.innerHTML = '<div class="st-empty">Scanning owners...</div>';
            try {
                const matched = await findIntersectedOwners(smartState.targetList, mtSmartLog);
                smartState.matchedOwners = matched;
                renderSmartMatchedList();
                mtSmartLog('Found ' + matched.length + ' users who own all selected items', matched.length ? 'ok' : 'info');
                updateSmartSummary();
            } catch(e) { mtSmartLog('Error: ' + e.message, 'err'); }
            btn.disabled = false; btn.textContent = 'Scan Owners';
        });

        // Smart clear
        panel.querySelector('#mt-smart-clear-btn').addEventListener('click', () => {
            smartState.targetList = [];
            renderSmartTargetList();
        });

        // Smart send
        panel.querySelector('#mt-smart-send-btn').addEventListener('click', () => {
            if (!smartState.mySelected.length || !smartState.matchedOwners.length) return;
            const count = smartState.maxSendCount ? Math.min(smartState.maxSendCount, smartState.matchedOwners.length) : smartState.matchedOwners.length;
            showConfirm('Send trade to ' + count + ' matched user(s)?\n\nOffering: ' + smartState.mySelected.map(i => i.name||'item').join(', '), () => doSmartBlast());
        });
        panel.querySelector('#mt-smart-stop-btn').addEventListener('click', () => { smartState.stopped = true; mtSmartLog('Stop requested...', 'info'); });
        bindDelayControls('mt-smart-delay-dec', 'mt-smart-delay-inc', 'mt-smart-delay-display', smartState);
        bindMaxControls('mt-smart-max-dec', 'mt-smart-max-inc', 'mt-smart-max-all', 'mt-smart-max-display', smartState);

        // Restore logs
        restoreLogs('mt-blast-log', blastState.logs);
        restoreLogs('mt-smart-log', smartState.logs);
    }

    // ─── Render functions ─────────────────────────────────────────────────────
    function renderMyGrid(items, selectedArr, wrapId, countId, rapId, valueId, maxSelect) {
        const wrap = document.getElementById(wrapId);
        if (!wrap) return;
        if (!items.length) { wrap.innerHTML = '<div class="mt-placeholder">No items found</div>'; return; }
        wrap.innerHTML = '';
        const grid = document.createElement('div');
        grid.className = 'mt-items-grid';
        for (const item of items) {
            const k       = getKoromons(item.assetId);
            const thumb   = assetThumbs[item.assetId] || ITEM_FB;
            const name    = item.name || 'Asset ' + item.assetId;
            const isSel   = selectedArr.some(s => s.userAssetId === item.userAssetId);
            const isMaxed = selectedArr.length >= maxSelect && !isSel;
            const card    = document.createElement('div');
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
                    const idx = selectedArr.findIndex(s => s.userAssetId === item.userAssetId);
                    if (idx >= 0) selectedArr.splice(idx, 1);
                    else if (selectedArr.length < maxSelect) selectedArr.push(item);
                    renderMyGrid(items, selectedArr, wrapId, countId, rapId, valueId, maxSelect);
                    updateMassTradeTotal(selectedArr, rapId, valueId);
                });
            }
            grid.appendChild(card);
        }
        wrap.appendChild(grid);
        const cnt = document.getElementById(countId);
        if (cnt) cnt.textContent = selectedArr.length + '/' + maxSelect;
    }

    function renderBlastMyGrid() {
        renderMyGrid(blastState.myItems, blastState.mySelected, 'mt-blast-my-items', 'mt-blast-my-count', 'mt-blast-rap', 'mt-blast-value', MAX_SELECT);
        updateBlastSummary();
    }

    function renderSmartMyGrid() {
        renderMyGrid(blastState.myItems, smartState.mySelected, 'mt-smart-my-items', 'mt-smart-my-count', 'mt-smart-rap', 'mt-smart-value', MAX_SELECT);
        updateSmartSummary();
    }

    function renderSmartTargetList() {
        const list = document.getElementById('mt-smart-target-list');
        const countEl = document.getElementById('mt-smart-target-count');
        const scanBtn = document.getElementById('mt-smart-scan-btn');
        if (!list) return;

        // Count copies per assetId
        const copyCounts = {};
        for (const t of smartState.targetList) copyCounts[t.assetId] = (copyCounts[t.assetId] || 0) + 1;

        if (!smartState.targetList.length) {
            list.innerHTML = '<div class="st-empty">Click items in the grid above to add them</div>';
        } else {
            // Deduplicate for display (show each unique item once with copy count)
            const seen = new Set();
            const rows = [];
            for (const t of smartState.targetList) {
                if (seen.has(t.assetId)) continue;
                seen.add(t.assetId);
                rows.push(t);
            }
            list.innerHTML = '';
            for (const t of rows) {
                const copies = copyCounts[t.assetId];
                const row = document.createElement('div');
                row.className = 'st-target-row';
                row.innerHTML =
                    '<img class="st-target-thumb" src="' + (t.thumb || ITEM_FB) + '">' +
                    '<div style="flex:1;min-width:0"><div class="st-target-name">' + esc(t.name) + '</div><div class="st-target-id">ID: ' + t.assetId + '</div></div>' +
                    '<span class="st-copy-badge">×' + copies + '</span>' +
                    '<div style="display:flex;flex-direction:column;gap:3px">' +
                        '<button class="st-remove-btn" data-id="' + t.assetId + '" title="Remove one copy">−</button>' +
                        '<button class="st-remove-btn" data-id="' + t.assetId + '" data-all="1" title="Remove all" style="font-size:12px">✕</button>' +
                    '</div>';
                row.querySelectorAll('.st-remove-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const id = parseInt(btn.dataset.id);
                        if (btn.dataset.all) {
                            smartState.targetList = smartState.targetList.filter(t => t.assetId !== id);
                        } else {
                            const idx = smartState.targetList.findLastIndex ? smartState.targetList.findLastIndex(t => t.assetId === id) : smartState.targetList.map(t=>t.assetId).lastIndexOf(id);
                            if (idx >= 0) smartState.targetList.splice(idx, 1);
                        }
                        renderSmartTargetList();
                    });
                });
                list.appendChild(row);
            }
        }

        const total = smartState.targetList.length;
        if (countEl) countEl.textContent = total + ' item' + (total !== 1 ? 's' : '') + (total !== Object.keys(copyCounts).length ? ' (' + Object.keys(copyCounts).length + ' unique)' : '');
        if (scanBtn) scanBtn.disabled = total === 0;
    }

    function renderSmartMatchedList() {
        const list = document.getElementById('mt-smart-matched-list');
        const countEl = document.getElementById('mt-smart-match-count');
        if (!list) return;
        const matched = smartState.matchedOwners;
        if (countEl) countEl.textContent = matched.length + ' found';
        if (!matched.length) { list.innerHTML = '<div class="st-empty">No users own all selected items</div>'; return; }
        list.innerHTML = '';
        for (const user of matched) {
            const row = document.createElement('div');
            row.className = 'st-matched-row';
            row.innerHTML =
                '<div><div>' + esc(user.username) + '</div><div class="st-matched-uid">UID: ' + user.userId + '</div></div>' +
                '<span class="st-items-badge">' + user.userAssetIds.length + ' item(s) to receive</span>';
            list.appendChild(row);
        }
    }

    function updateBlastSummary() {
        const el  = document.getElementById('mt-blast-summary');
        const btn = document.getElementById('mt-blast-btn');
        if (!el) return;
        if (blastState.targetOwners.length && blastState.targetAssetId) {
            el.style.display = 'block';
            const myVal = blastState.mySelected.reduce((s, i) => s + ((koromonsItems[i.assetId]||{}).value||0), 0);
            el.innerHTML = '<b style="color:#fff">' + blastState.targetOwners.length + '</b> owners · Offering: <b style="color:#c8944a">' + (blastState.mySelected.length ? blastState.mySelected.map(i=>i.name||'item').join(', ') : 'nothing') + '</b>' + (myVal ? ' · <b style="color:#66bb6a">' + myVal.toLocaleString() + '</b>' : '');
        } else el.style.display = 'none';
        if (btn) btn.disabled = !blastState.mySelected.length || !blastState.targetOwners.length;
    }

    function updateSmartSummary() {
        const el  = document.getElementById('mt-smart-summary');
        const btn = document.getElementById('mt-smart-send-btn');
        if (!el) return;
        if (smartState.matchedOwners.length) {
            el.style.display = 'block';
            el.innerHTML = '<b style="color:#fff">' + smartState.matchedOwners.length + '</b> matched users · Offering: <b style="color:#c8944a">' + (smartState.mySelected.length ? smartState.mySelected.map(i=>i.name||'item').join(', ') : 'nothing') + '</b>';
        } else el.style.display = 'none';
        if (btn) btn.disabled = !smartState.mySelected.length || !smartState.matchedOwners.length;
    }

    // ─── Controls helpers ─────────────────────────────────────────────────────
    function bindDelayControls(decId, incId, displayId, state) {
        const display = document.getElementById(displayId);
        const update  = () => {
            const s = state.delaySeconds;
            if (display) display.textContent = s >= 60 ? (s/60).toFixed(1).replace('.0','') + 'm' : s + 's';
        };
        document.getElementById(decId)?.addEventListener('click', () => {
            if (state.delaySeconds > 5) {
                if (state.delaySeconds <= 60) state.delaySeconds -= 5;
                else if (state.delaySeconds <= 300) state.delaySeconds -= 30;
                else state.delaySeconds -= 60;
                update();
            }
        });
        document.getElementById(incId)?.addEventListener('click', () => {
            if (state.delaySeconds < 1200) {
                if (state.delaySeconds < 60) state.delaySeconds += 5;
                else if (state.delaySeconds < 300) state.delaySeconds += 30;
                else state.delaySeconds += 60;
                update();
            }
        });
        update();
    }

    function bindMaxControls(decId, incId, allId, displayId, state) {
        const display = document.getElementById(displayId);
        const update  = () => { if (display) display.textContent = state.maxSendCount === null ? 'All' : state.maxSendCount; };
        document.getElementById(decId)?.addEventListener('click', () => { if (state.maxSendCount === null) state.maxSendCount = 1; else if (state.maxSendCount > 1) state.maxSendCount--; update(); });
        document.getElementById(incId)?.addEventListener('click', () => { if (state.maxSendCount === null) state.maxSendCount = 1; else state.maxSendCount++; update(); });
        document.getElementById(allId)?.addEventListener('click', () => { state.maxSendCount = null; update(); });
        update();
    }

    // ─── Send loop (shared by blast tab) ──────────────────────────────────────
    async function doBlast(state, prefix) {
        if (state.sending) return;
        state.sending = true; state.stopped = false;
        const blastBtn = document.getElementById(prefix + '-btn');
        const stopBtn  = document.getElementById(prefix + '-stop-btn');
        const progress = document.getElementById(prefix + '-progress');
        const bar      = document.getElementById(prefix + '-progress-bar');
        if (blastBtn) blastBtn.style.display = 'none';
        if (stopBtn)  stopBtn.style.display  = '';
        if (progress) progress.style.display = 'block';
        const log = prefix === 'mt-blast' ? mtBlastLog : mtSmartLog;

        const myUid  = await getMyUserId();
        const owners = state.maxSendCount ? state.targetOwners.slice(0, state.maxSendCount) : state.targetOwners;
        let sent = 0, failed = 0, skipped = 0;
        log('Starting blast to ' + owners.length + ' owners...', 'info');

        for (let i = 0; i < owners.length; i++) {
            if (state.stopped) { log('Stopped. Sent: ' + sent + ' | Failed: ' + failed, 'info'); break; }
            if (bar) bar.style.width = Math.round((i / owners.length) * 100) + '%';
            const owner = owners[i];
            try {
                await apiPost(EP_TRADE_SEND, { offers: [
                    { userId: myUid, userAssetIds: state.mySelected.map(x => x.userAssetId) },
                    { userId: owner.userId, userAssetIds: [owner.userAssetId] }
                ]});
                sent++; log('✓ [' + (i+1) + '/' + owners.length + '] ' + owner.username, 'ok');
            } catch(e) {
                const msg = (e.message||'').toLowerCase();
                if (msg.includes('already') || msg.includes('pending') || msg.includes('429')) { skipped++; log('⚠ Skipped ' + owner.username, 'info'); }
                else { failed++; log('✗ ' + owner.username + ': ' + e.message, 'err'); }
            }
            if (i < owners.length - 1 && !state.stopped) await new Promise(r => setTimeout(r, state.delaySeconds * 1000));
        }

        if (bar) bar.style.width = '100%';
        log('✅ Done! Sent: ' + sent + ' | Failed: ' + failed + ' | Skipped: ' + skipped, 'ok');
        state.sending = false;
        if (blastBtn) { blastBtn.style.display = ''; blastBtn.disabled = false; }
        if (stopBtn) stopBtn.style.display = 'none';
    }

    // ─── Smart send loop ──────────────────────────────────────────────────────
    async function doSmartBlast() {
        if (smartState.sending) return;
        smartState.sending = true; smartState.stopped = false;
        const blastBtn = document.getElementById('mt-smart-send-btn');
        const stopBtn  = document.getElementById('mt-smart-stop-btn');
        const progress = document.getElementById('mt-smart-progress');
        const bar      = document.getElementById('mt-smart-progress-bar');
        if (blastBtn) blastBtn.style.display = 'none';
        if (stopBtn)  stopBtn.style.display  = '';
        if (progress) progress.style.display = 'block';

        const myUid  = await getMyUserId();
        const owners = smartState.maxSendCount ? smartState.matchedOwners.slice(0, smartState.maxSendCount) : smartState.matchedOwners;
        let sent = 0, failed = 0, skipped = 0;
        mtSmartLog('Sending to ' + owners.length + ' matched users...', 'info');

        for (let i = 0; i < owners.length; i++) {
            if (smartState.stopped) { mtSmartLog('Stopped. Sent: ' + sent, 'info'); break; }
            if (bar) bar.style.width = Math.round((i / owners.length) * 100) + '%';
            const owner = owners[i];
            try {
                // Their side = all the userAssetIds from the intersection scan
                await apiPost(EP_TRADE_SEND, { offers: [
                    { userId: myUid,        userAssetIds: smartState.mySelected.map(x => x.userAssetId) },
                    { userId: owner.userId, userAssetIds: owner.userAssetIds }
                ]});
                sent++; mtSmartLog('✓ [' + (i+1) + '/' + owners.length + '] ' + owner.username, 'ok');
            } catch(e) {
                const msg = (e.message||'').toLowerCase();
                if (msg.includes('already') || msg.includes('pending') || msg.includes('429')) { skipped++; mtSmartLog('⚠ Skipped ' + owner.username, 'info'); }
                else { failed++; mtSmartLog('✗ ' + owner.username + ': ' + e.message, 'err'); }
            }
            if (i < owners.length - 1 && !smartState.stopped) await new Promise(r => setTimeout(r, smartState.delaySeconds * 1000));
        }

        if (bar) bar.style.width = '100%';
        mtSmartLog('✅ Done! Sent: ' + sent + ' | Failed: ' + failed + ' | Skipped: ' + skipped, 'ok');
        smartState.sending = false;
        if (blastBtn) { blastBtn.style.display = ''; blastBtn.disabled = false; }
        if (stopBtn) stopBtn.style.display = 'none';
    }

    function closeMassTradePanel() {
        document.getElementById('mass-trade-ov')?.remove();
        document.getElementById('mass-trade-panel')?.remove();
    }

    function makeLogger(logId, logArr) {
        return (msg, type) => {
            logArr.push({ msg, type: type || 'info' });
            const log = document.getElementById(logId);
            if (!log) return;
            const d = document.createElement('div');
            d.className = 'mt-log-item mt-log-' + (type || 'info');
            d.textContent = msg;
            log.appendChild(d);
            log.scrollTop = log.scrollHeight;
        };
    }

    function mtBlastLog(msg, type) { makeLogger('mt-blast-log', blastState.logs)(msg, type); }
    function mtSmartLog(msg, type) { makeLogger('mt-smart-log', smartState.logs)(msg, type); }

    function restoreLogs(logId, logs) {
        const log = document.getElementById(logId);
        if (!log || !logs.length) return;
        for (const entry of logs) {
            const d = document.createElement('div');
            d.className = 'mt-log-item mt-log-' + entry.type;
            d.textContent = entry.msg;
            log.appendChild(d);
        }
        log.scrollTop = log.scrollHeight;
    }

    // ─── FAB ──────────────────────────────────────────────────────────────────
    function injectFab() {
        if (document.getElementById('mts-fab')) return;
        const fab = document.createElement('button');
        fab.id = 'mts-fab';
        fab.title = 'Mass Trade Sender';
        fab.innerHTML = iconImg(32);
        fab.addEventListener('click', () => { injectCss(); showMassTradePanel(); });
        document.body.appendChild(fab);
    }

    async function init() {
        await seedCsrf();
        await fetchIcon();
        injectFab();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

})();
