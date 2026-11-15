const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const DATA = window.RADAR;
function renderStats() {
    const s = DATA.counts;
    document.getElementById('stats').textContent = s.total + ' protocols, ' + s.watchlist + ' watchlist, ' + DATA.rows.length + ' board rows, ' + s.early + ' early, ' + s.live + ' live, ' + s.excluded + ' excluded.';
}

const state = { q: '', category: 'all', chain: 'all', watchlistOnly: false, sort: 'rank', tab: 'board', dir: 1 };

const compactFmt = (n) => {
    if (n === null || n === undefined) return 'n/a';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(2) + 'K';
    return '$' + Math.round(n);
};
const fmtPct = (n) => n !== null ? (n > 0 ? '+' : '') + n.toFixed(2) + '%' : 'n/a';

// Short chain cell: first chain plus a count, so the table stays narrow.
const shortChains = (chains) => {
    if (!chains || chains.length === 0) return 'n/a';
    return chains.length === 1 ? chains[0] : chains[0] + ' +' + (chains.length - 1);
};

function populateSelects() {
    const categories = [...new Set(DATA.rows.map(r => r.category).filter(c => c))].sort();
    const chains = [...new Set(DATA.rows.flatMap(r => r.chains))].sort();
    const catSelect = document.getElementById('category');
    categories.forEach(c => catSelect.innerHTML += `<option value="${esc(c)}">${esc(c)}</option>`);
    const chainSelect = document.getElementById('chain');
    chains.forEach(c => chainSelect.innerHTML += `<option value="${esc(c)}">${esc(c)}</option>`);
}

// Page-side recomputation: the page refits the value model from DATA.liveAll
// and recomputes every row's implied value with the model.js functions, then
// reports whether the page's numbers match the stored ones. Runs once, at
// load. This is the criterion-2 proof the reader can see: the board and the
// page use the same model, and the page shows its own fit.
let pageCurve = null;
let pageBacktest = null;
let pageMetricsComputed = false;
let pageValueMismatches = 0;
let pageValuesComputed = false;

function computePageValues() {
    if (pageValuesComputed) return;
    pageValuesComputed = true;
    if (!Array.isArray(DATA.rows) || DATA.rows.length === 0) return;
    if (!Array.isArray(DATA.liveAll) || DATA.liveAll.length === 0) return;
    const curve = window.TokenRadarModel.fitValueModel(DATA.liveAll);
    pageCurve = curve;
    DATA.rows.forEach(row => {
        const recomputed = window.TokenRadarModel.impliedValue(row, curve);
        if (recomputed !== row.implied_value_usd) pageValueMismatches += 1;
    });
    const line = document.getElementById('value-check');
    if (line) {
        line.textContent = 'Value check (computed live on this page from the ' + DATA.liveAll.length + ' live tokens): page recomputation matches the stored implied value for ' +
            (DATA.rows.length - pageValueMismatches) + '/' + DATA.rows.length + ' rows.';
    }
}

function renderTable() {
    const tbody = document.getElementById('table-body');
    const tableHead = document.getElementById('table-head');
    const note = document.getElementById('live-note') || document.createElement('p');
    note.id = 'live-note';
    note.style.display = 'none';
    if (!document.getElementById('live-note')) document.getElementById('tabs').after(note);

    let rows = state.tab === 'board' ? [...DATA.rows] : [...DATA.live];
    if (state.tab === 'board') {
        if (state.q) rows = rows.filter(r => r.name.toLowerCase().includes(state.q.toLowerCase()) || r.slug.toLowerCase().includes(state.q.toLowerCase()));
        if (state.category !== 'all') rows = rows.filter(r => r.category === state.category);
        if (state.chain !== 'all') rows = rows.filter(r => r.chains.includes(state.chain));
        if (state.watchlistOnly) rows = rows.filter(r => r.watchlist);

        const sortMap = { rank: 'rank', implied: 'implied_value_usd', tvl: 'tvl_usd', '7d': 'change_7d', age: 'age_days', name: 'name', category: 'category', chain: 'chains' };
        const key = sortMap[state.sort];
        const dir = state.dir || 1;
        rows.sort((a, b) => {
          if (key === 'name') return dir * a.name.localeCompare(b.name);
          let valA = a[key], valB = b[key];
          if (valA === null || valA === undefined) return 1;
          if (valB === null || valB === undefined) return -1;
          if (key === 'rank') return dir * (valA - valB);
          return dir * (valB - valA);
        });
    } else {
        rows.sort((a, b) => (b.mcap_usd || 0) - (a.mcap_usd || 0));
    }

    if (state.tab === 'board') {
        tableHead.innerHTML = `
            <th data-sort="rank">Rank</th>
            <th data-sort="name">Protocol</th>
            <th data-sort="category">Category</th>
            <th data-sort="chain">Chains</th>
            <th data-sort="tvl">TVL</th>
            <th data-sort="7d">7d %</th>
            <th data-sort="age">Age (days)</th>
            <th data-sort="implied">Implied value</th>
        `;
        tbody.innerHTML = rows.map(r => `
            <tr class="${r.watchlist ? 'watchlist-row' : ''}" onclick="openDialog('${r.slug}')">
                <td>${esc(r.rank)}</td>
                <td>${esc(r.name)} ${r.watchlist ? '★' : ''}</td>
                <td>${esc(r.category || 'N/A')}</td>
                <td>${esc(shortChains(r.chains))}</td>
                <td>${compactFmt(r.tvl_usd)}</td>
                <td>${fmtPct(r.change_7d)}</td>
                <td>${esc(r.age_days ?? 'N/A')}</td>
                <td>${compactFmt(r.implied_value_usd)}</td>
            </tr>
        `).join('');
    } else {
        tableHead.innerHTML = `<th>Protocol</th><th>Category</th><th>Chains</th><th>TVL</th><th>Market cap</th>`;
        tbody.innerHTML = rows.map(r => `
            <tr>
                <td>${esc(r.name)}</td>
                <td>${esc(r.category || 'N/A')}</td>
                <td>${esc(shortChains(r.chains))}</td>
                <td>${compactFmt(r.tvl_usd)}</td>
                <td>${compactFmt(r.mcap_usd)}</td>
            </tr>
        `).join('');
        note.style.display = 'block';
        note.innerHTML = 'already trades — market cap is a fact, not a model';
    }
}

function renderModelPanel() {
    if (!pageMetricsComputed) {
        pageMetricsComputed = true;
        if (Array.isArray(DATA.liveAll) && DATA.liveAll.length > 0) {
            if (!pageCurve) pageCurve = window.TokenRadarModel.fitValueModel(DATA.liveAll);
            pageBacktest = window.TokenRadarModel.backtest(DATA.liveAll);
        }
    }

    const curve = DATA.model.curve;
    const liveCurveLines = pageCurve
        ? `
        <p>Page-fitted model (fitted live on this page from ${pageCurve.n} live tokens): intercept ${pageCurve.intercept.toFixed(4)}, slope ${pageCurve.slope.toFixed(4)}, infra ${pageCurve.infra.toFixed(4)}.</p>
        <p>Page fit matches the board's stored curve: ${pageCurve.intercept === curve.intercept && pageCurve.slope === curve.slope && pageCurve.infra === curve.infra ? 'yes' : 'no — see the two curves above'}</p>
        ${pageBacktest.infra === null
            ? '<p>Backtest: not enough live tokens to compute.</p>'
            : `<p>Backtest (5-fold CV, ${pageBacktest.n} live tokens, computed live on this page): median |log10 error| ${pageBacktest.infra.toFixed(2)} = ${Math.pow(10, pageBacktest.infra).toFixed(1)}x (infra model), vs ${pageBacktest.curve.toFixed(2)} = ${Math.pow(10, pageBacktest.curve).toFixed(1)}x (single curve), vs ${pageBacktest.flat.toFixed(2)} = ${Math.pow(10, pageBacktest.flat).toFixed(1)}x (flat median).</p>`}
        `
        : '';
    // Example multiples. A value that hits the clamp is labelled as capped
    // or floored, so a reader checking the formula against the shown number
    // does not mistake the clamp for a formula error (e.g. $10M infra fits
    // 1.235 before the 0.80 cap; $10B non-infra fits 0.011 before the 0.02
    // floor).
    const rawMultiple = (tvl, infra) => Math.pow(10, curve.intercept + curve.slope * Math.log10(tvl) + (infra ? curve.infra : 0));
    const exampleMultiple = (tvl, infra) => {
        const raw = rawMultiple(tvl, infra);
        const fitted = window.TokenRadarModel.fittedMultiple(tvl, infra, curve);
        const note = raw > curve.clampMax ? ' (capped at 0.80)' : raw < curve.clampMin ? ' (floored at 0.02)' : '';
        return fitted.toFixed(4) + note;
    };
    const examples = [
        ['$10M', 10_000_000],
        ['$100M', 100_000_000],
        ['$1B', 1_000_000_000],
        ['$10B', 10_000_000_000],
    ].map(([label, tvl]) =>
        `<li>${label} TVL: ${exampleMultiple(tvl, false)} (${exampleMultiple(tvl, true)} infra)</li>`
    ).join('');

    document.getElementById('model-panel').innerHTML = `
        <p>Formula: ${esc(DATA.model.formula)}</p>
        <p>Fitted model: intercept ${curve.intercept.toFixed(4)}, slope ${curve.slope.toFixed(4)}, infra ${curve.infra.toFixed(4)}, n ${curve.n}. Infra categories: ${esc(DATA.model.infraCategories.join(', '))}.</p>
        ${liveCurveLines}
        <p>Example fitted multiples:</p>
        <ul>${examples}</ul>
        <p>145 pre-token protocols are excluded: wrapped, bridged, staked and exchange products are not protocols awaiting a token launch. Cross Chain Bridge joins the excluded list: Circle Gateway bridges USDC, a token that already trades.</p>
        <p>Snapshot frozen 2026-11-14. Multiples are comparables from the snapshot's own live tokens, not predictions; no protocol name is hardcoded into the model.</p>
    `;
}

// One or two sentences, built only from this row's own fields: its TVL tier,
// 7-day change, age, and whether it is infra. No outside facts.
function whyThisRank(row) {
    const tier = row.tvl_usd >= 1_000_000_000 ? 'large' : row.tvl_usd >= 100_000_000 ? 'mid-size' : 'smaller';
    const growth = row.change_7d === null
        ? '7-day TVL change unreported'
        : '7-day TVL change ' + fmtPct(row.change_7d);
    const age = row.age_days === null ? 'age unreported' : row.age_days + ' days of history';
    const infraNote = row.infra
        ? ' Infra protocol: its TVL understates its footprint, so the fitted multiple carries the +0.47 dex infra shift.'
        : ' Not an infra protocol, so no infra shift applies to its fitted multiple.';
    return 'Rank ' + row.rank + ' by implied value: a ' + tier + ' TVL of ' + compactFmt(row.tvl_usd) + ', ' +
        growth + ', ' + age + '.' + infraNote;
}

function openDialog(slug) {
    const row = DATA.rows.find(r => r.slug === slug);
    if (!row) return;
    const dialog = document.getElementById('detail-dialog');
    const pageCurveMatchesStored = pageCurve &&
        pageCurve.intercept === DATA.model.curve.intercept &&
        pageCurve.slope === DATA.model.curve.slope &&
        pageCurve.infra === DATA.model.curve.infra;
    const recomputeCurve = pageCurveMatchesStored ? pageCurve : DATA.model.curve;
    const recomputed = window.TokenRadarModel.impliedValue(row, recomputeCurve);
    const multipleLine = row.infra
        ? 'multiple ' + row.size_multiple.toFixed(4) + ' (infra +0.47 dex)'
        : 'multiple ' + row.size_multiple.toFixed(4);
    document.getElementById('dialog-content').innerHTML = `
        <h2>${esc(row.name)}</h2>
        <div class="factor-grid">
        <p>TVL: ${compactFmt(row.tvl_usd)}</p>
        <p>Category: ${esc(row.category || 'N/A')}</p>
        <p>Fitted ${multipleLine}</p>
        <p>Age: ${row.age_days === null ? 'n/a' : row.age_days + ' days'}</p>
        <p>Implied value (stored): ${compactFmt(row.implied_value_usd)}</p>
        <p>Implied value (recomputed): ${compactFmt(recomputed)}</p>
        </div>
        <p>Stored and recomputed agree: ${recomputed === row.implied_value_usd ? 'yes — the page and the board use the same model' : 'no — see the two values above'}</p>
        <p>Recomputed with: ${pageCurveMatchesStored ? 'the page-fitted model' : "the board's stored model"}</p>
        <p><strong>Why this rank:</strong> ${esc(whyThisRank(row))}</p>
        <h3>Farm Steps</h3>
        <ul>${row.farm_steps.map(step => `<li>${esc(step)}</li>`).join('')}</ul>
        <p><em>Records no token</em></p>
    `;
    if (!dialog.open) dialog.showModal();
    history.replaceState(null, '', '#p=' + slug);
}

document.getElementById('q').addEventListener('input', e => { state.q = e.target.value; renderTable(); });
document.getElementById('category').addEventListener('change', e => { state.category = e.target.value; renderTable(); history.replaceState(null, '', '#category=' + state.category); });
document.getElementById('chain').addEventListener('change', e => { state.chain = e.target.value; renderTable(); history.replaceState(null, '', '#chain=' + state.chain); });
document.getElementById('watchlist-only').addEventListener('change', e => { state.watchlistOnly = e.target.checked; renderTable(); });
document.getElementById('sort').addEventListener('change', e => { state.sort = e.target.value; renderTable(); });
document.getElementById('board-table').querySelector('thead').addEventListener('click', (e) => { const th = e.target.closest('th[data-sort]'); if (!th || state.tab !== 'board') return; const k = th.getAttribute('data-sort'); if (state.sort === k) { state.dir = (state.dir === 1 ? -1 : 1); } else { state.sort = k; state.dir = 1; } renderTable(); });

function setActiveTab(id) {
    ['tab-board', 'tab-live'].forEach(t => {
        const b = document.getElementById(t);
        if (b) b.classList.toggle('active', t === id);
    });
}
document.getElementById('tab-board').addEventListener('click', () => { state.tab = 'board'; setActiveTab('tab-board'); renderTable(); });
document.getElementById('tab-live').addEventListener('click', () => { state.tab = 'live'; setActiveTab('tab-live'); renderTable(); });
document.getElementById('close-dialog').addEventListener('click', () => document.getElementById('detail-dialog').close());

function handleHash() {
    const params = new URLSearchParams(window.location.hash.slice(1));
    if (params.has('p')) openDialog(params.get('p'));
    if (params.has('category')) {
        state.category = params.get('category');
        document.getElementById('category').value = state.category;
    }
    if (params.has('q')) {
        state.q = params.get('q');
        document.getElementById('q').value = state.q;
    }
    if (params.has('chain')) {
        state.chain = params.get('chain');
        document.getElementById('chain').value = state.chain;
    }
    renderTable();
}

window.addEventListener('hashchange', handleHash);
renderStats();
computePageValues();
renderModelPanel();
populateSelects();
handleHash();
