const AGENTS = [
  { name: "Peter", cardFactor: 13, kouzaFactor: 10 },
  { name: "Sandeep", cardFactor: 12, kouzaFactor: 10 },
  { name: "Nvn", cardFactor: 12, kouzaFactor: 10 },
  { name: "Oxy", cardFactor: 10, kouzaFactor: 9 },
  { name: "Nikhil", cardFactor: 10, kouzaFactor: 9 },
  { name: "Sanju", cardFactor: 13, kouzaFactor: 10 },
  { name: "Viswas", cardFactor: 10, kouzaFactor: 9 },
  { name: "Talpade", cardFactor: 8, kouzaFactor: 7 },
  { name: "Deepak", cardFactor: 10, kouzaFactor: 9 },
  { name: "Shweta", cardFactor: 10, kouzaFactor: 10 },
  { name: "Pankaj", cardPerMaan: 100, kouzaPerMaan: 150 },
];

const tbody = document.getElementById("agent-rows");
const grandTotalEl = document.getElementById("grand-total");
const recordDateEl = document.getElementById("record-date");
const savedDaysEl = document.getElementById("saved-days");
const storageStatusEl = document.getElementById("storage-status");
const btnSave = document.getElementById("btn-save");
const btnLoad = document.getElementById("btn-load");
const btnLogout = document.getElementById("btn-logout");

async function apiFetch(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.href = "/login.html";
    throw new Error("Login required");
  }
  return res;
}

const inrFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

function parseMaan(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function formatInr(amount) {
  return inrFormatter.format(Math.round(amount));
}

function getRates(agent) {
  if (agent.cardPerMaan != null && agent.kouzaPerMaan != null) {
    return { cardPerMaan: agent.cardPerMaan, kouzaPerMaan: agent.kouzaPerMaan };
  }
  return {
    cardPerMaan: agent.cardFactor * 100,
    kouzaPerMaan: agent.kouzaFactor * 100,
  };
}

function formatRatioLabel(agent) {
  if (agent.cardPerMaan != null && agent.kouzaPerMaan != null) {
    return `${agent.cardPerMaan}/${agent.kouzaPerMaan}`;
  }
  return `${agent.cardFactor}/${agent.kouzaFactor}`;
}

function formatRateHint(rates) {
  return `Card ₹${rates.cardPerMaan.toLocaleString("en-IN")}/maan · Kouza ₹${rates.kouzaPerMaan.toLocaleString("en-IN")}/maan`;
}

function todayIsoDate() {
  const d = new Date();
  const tzOffset = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tzOffset).toISOString().slice(0, 10);
}

function setStorageStatus(message, isError = false) {
  storageStatusEl.textContent = message;
  storageStatusEl.classList.toggle("is-error", isError);
}

function collectSnapshot() {
  const agents = {};
  let grandTotal = 0;

  tbody.querySelectorAll("tr").forEach((row) => {
    const name = row.dataset.agentName;
    const cardMaan = parseMaan(row.querySelector(".input-card").value);
    const kouzaMaan = parseMaan(row.querySelector(".input-kouza").value);
    const cardPerMaan = Number(row.dataset.cardPerMaan);
    const kouzaPerMaan = Number(row.dataset.kouzaPerMaan);
    const cardInr = cardMaan * cardPerMaan;
    const kouzaInr = kouzaMaan * kouzaPerMaan;
    const totalInr = cardInr + kouzaInr;

    agents[name] = { cardMaan, kouzaMaan, totalInr };
    grandTotal += totalInr;
  });

  return { agents, grandTotal };
}

function applySnapshot(agents) {
  tbody.querySelectorAll("tr").forEach((row) => {
    const name = row.dataset.agentName;
    const entry = agents[name];
    const cardInput = row.querySelector(".input-card");
    const kouzaInput = row.querySelector(".input-kouza");
    if (entry) {
      cardInput.value = entry.cardMaan === 0 ? "" : String(entry.cardMaan);
      kouzaInput.value = entry.kouzaMaan === 0 ? "" : String(entry.kouzaMaan);
    } else {
      cardInput.value = "";
      kouzaInput.value = "";
    }
  });
  recalculateAll();
}

async function refreshSavedDays(selectDate) {
  try {
    const res = await apiFetch("/api/days");
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Could not list days (${res.status})`);
    }
    const { dates } = await res.json();
    savedDaysEl.innerHTML = '<option value="">— Load a saved day —</option>';
    dates.forEach((date) => {
      const opt = document.createElement("option");
      opt.value = date;
      opt.textContent = date;
      savedDaysEl.appendChild(opt);
    });
    if (selectDate && dates.includes(selectDate)) {
      savedDaysEl.value = selectDate;
    }
    setStorageStatus(
      dates.length
        ? `${dates.length} saved day(s) in Redis.`
        : "Redis connected. No saved days yet."
    );
  } catch (err) {
    setStorageStatus(err.message, true);
  }
}

async function saveCurrentDay() {
  const date = recordDateEl.value;
  if (!date) {
    setStorageStatus("Pick a date first.", true);
    return;
  }
  const snapshot = collectSnapshot();
  btnSave.disabled = true;
  setStorageStatus("Saving…");
  try {
    const res = await apiFetch(`/api/days/${date}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Save failed (${res.status})`);
    }
    setStorageStatus(`Saved ${date} at ${new Date(data.record.savedAt).toLocaleString()}.`);
    await refreshSavedDays(date);
  } catch (err) {
    setStorageStatus(err.message, true);
  } finally {
    btnSave.disabled = false;
  }
}

async function loadDay(date) {
  const target = date || savedDaysEl.value || recordDateEl.value;
  if (!target) {
    setStorageStatus("Choose a date or pick a saved day.", true);
    return;
  }
  btnLoad.disabled = true;
  setStorageStatus(`Loading ${target}…`);
  try {
    const res = await apiFetch(`/api/days/${target}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Load failed (${res.status})`);
    }
    recordDateEl.value = data.date;
    applySnapshot(data.agents);
    setStorageStatus(`Loaded ${data.date} (saved ${new Date(data.savedAt).toLocaleString()}).`);
    savedDaysEl.value = data.date;
  } catch (err) {
    setStorageStatus(err.message, true);
  } finally {
    btnLoad.disabled = false;
  }
}

function initStorage() {
  recordDateEl.value = todayIsoDate();
  btnSave.addEventListener("click", saveCurrentDay);
  btnLoad.addEventListener("click", () => loadDay());
  btnLogout.addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/login.html";
  });
  savedDaysEl.addEventListener("change", () => {
    if (savedDaysEl.value) {
      recordDateEl.value = savedDaysEl.value;
    }
  });
  refreshSavedDays();
}

function recalculateAll() {
  let grandTotal = 0;

  tbody.querySelectorAll("tr").forEach((row) => {
    const cardMaan = parseMaan(row.querySelector(".input-card").value);
    const kouzaMaan = parseMaan(row.querySelector(".input-kouza").value);
    const cardPerMaan = Number(row.dataset.cardPerMaan);
    const kouzaPerMaan = Number(row.dataset.kouzaPerMaan);

    const cardInr = cardMaan * cardPerMaan;
    const kouzaInr = kouzaMaan * kouzaPerMaan;
    const total = cardInr + kouzaInr;

    row.querySelector(".cell-total").textContent = formatInr(total);
    grandTotal += total;
  });

  grandTotalEl.textContent = formatInr(grandTotal);
}

function buildRows() {
  AGENTS.forEach((agent) => {
    const rates = getRates(agent);
    const tr = document.createElement("tr");
    tr.dataset.agentName = agent.name;
    tr.dataset.cardPerMaan = rates.cardPerMaan;
    tr.dataset.kouzaPerMaan = rates.kouzaPerMaan;

    const ratio = formatRatioLabel(agent);
    const rateHint = formatRateHint(rates);

    tr.innerHTML = `
      <td class="col-agent">
        <div class="agent-head">
          <span class="agent-name">${agent.name}</span>
          <span class="ratio-badge ratio-mobile">${ratio}</span>
        </div>
        <span class="rate-hint-mobile">${rateHint}</span>
      </td>
      <td class="col-ratio ratio-cell" title="${rateHint}">
        <span class="ratio-fraction">${ratio}</span>
        <span class="ratio-rates">${rateHint}</span>
      </td>
      <td class="cell-input" data-label="Card sale">
        <input
          type="number"
          class="input-card"
          min="0"
          step="any"
          inputmode="decimal"
          placeholder="Enter the value in maan"
          aria-label="${agent.name} card sale in maan, ${rates.cardPerMaan} rupees per maan"
        />
      </td>
      <td class="cell-input" data-label="Kouza sale">
        <input
          type="number"
          class="input-kouza"
          min="0"
          step="any"
          inputmode="decimal"
          placeholder="Enter the value in maan"
          aria-label="${agent.name} kouza sale in maan, ${rates.kouzaPerMaan} rupees per maan"
        />
      </td>
      <td class="col-num cell-total cell-result" data-label="Total incentive (INR)">₹0</td>
    `;

    tr.querySelector(".input-card").addEventListener("input", recalculateAll);
    tr.querySelector(".input-kouza").addEventListener("input", recalculateAll);

    tbody.appendChild(tr);
  });

  recalculateAll();
}

buildRows();
initStorage();
