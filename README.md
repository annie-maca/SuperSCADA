# SuperSCADA — Anaerobic Digestion SCADA Dashboard

Industrial-grade SCADA dashboard for wastewater treatment plant anaerobic digestion monitoring, with real-time simulated data, derived process variables, soft sensors, and an AI prediction layer.

---

## Architecture

```
SuperSCADA.jsx          ← Self-contained React frontend (runs standalone)
supersca_da_backend.py  ← Optional FastAPI backend (REST + WebSocket)
```

The React artifact (`SuperSCADA.jsx`) is **fully self-contained** — it includes the mock data engine and AI model inline. The Python backend is provided for production-style integration.

---

## Option A — Run Standalone (React only, no backend)

### Prerequisites
- Node.js 18+
- A React project (Vite or Create React App)
- Recharts: `npm install recharts`

### Steps

```bash
# 1. Create a new Vite + React project
npm create vite@latest supersca-da -- --template react
cd supersca-da

# 2. Install Recharts
npm install recharts

# 3. Replace src/App.jsx with SuperSCADA.jsx contents
# (or import it as a component)

# 4. Start the dev server
npm run dev
```

The dashboard runs at `http://localhost:5173` — no backend needed.

---

## Option B — Full Stack (React + FastAPI backend)

### Backend setup

```bash
# Install Python dependencies
pip install fastapi uvicorn numpy

# Start the API server
python supersca_da_backend.py
# → Running at http://localhost:8000
```

### API Endpoints

| Method | Path                   | Description                          |
|--------|------------------------|--------------------------------------|
| GET    | /api/tags              | Current tag snapshot                 |
| GET    | /api/history?n=120     | Last N historian readings            |
| GET    | /api/predict           | AI next-step prediction              |
| GET    | /api/alarms            | Recent alarm log                     |
| GET    | /api/status            | System health summary                |
| GET    | /api/tags/definitions  | Tag metadata (IDs, units, limits)    |
| POST   | /api/control           | Set feed rate (JSON body)            |
| WS     | /ws/stream             | WebSocket live stream (2s cadence)   |

### Connect React to backend

In `SuperSCADA.jsx`, replace the `engine.tick()` call with a `fetch('/api/tags')` call:

```js
// In the runTick function, replace engine.tick() with:
const res = await fetch('http://localhost:8000/api/tags');
const d = await res.json();
setData(d);
```

Set feed rate via API:
```js
await fetch('http://localhost:8000/api/control', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ feed_rate: feedRate / 100 })
});
```

---

## SCADA Tags

| Tag ID        | Parameter             | Unit      | Alarm Lo | Alarm Hi |
|---------------|-----------------------|-----------|----------|----------|
| AD-FLOW-001   | Influent Sludge Flow  | m³/day    | 150      | 550      |
| AD-TEMP-001   | Digester Temperature  | °C        | 32       | 40       |
| AD-PH-001     | pH                    | —         | 6.5      | 7.8      |
| AD-ALK-001    | Alkalinity            | mg/L CaCO₃| 1800     | 3800     |
| AD-GAS-001    | Biogas Production     | m³/day    | 350      | 880      |
| AD-CH4-001    | Methane Content       | %         | 58       | 73       |
| AD-VS-001     | Volatile Solids Load  | kg/day    | 900      | 2200     |

### Derived Variables (Soft Sensors)

| Variable       | Formula                                      |
|----------------|----------------------------------------------|
| OLR            | VS_loading / digester_volume (5000 m³)       |
| Methane Yield  | (Biogas × CH₄%) / (VS_loading / 1000)       |
| VFA Estimate   | Soft sensor: 500 − Alk×0.1 + max(0, (7.2−pH)×300) |
| VFA/Alk Ratio  | VFA_estimate / Alkalinity                    |
| Energy (kWh)   | Biogas × (CH₄/100) × 9.97 × 0.40           |

---

## AI Prediction Model

The model uses **AR(1) + Process Physics**:

1. **AR(1)**: Extrapolates each tag using recent trend + mean-reversion
2. **Process physics**: Adjusts biogas prediction for temperature and pH effects
3. **Risk classification**: Flags HIGH/MEDIUM/LOW risk for:
   - VFA accumulation (VFA/Alk > 0.25 → MEDIUM, > 0.35 → HIGH)
   - Biogas decline (< 480 → MEDIUM, < 380 → HIGH)
   - pH instability (< 6.9 → MEDIUM, < 6.6 → HIGH)

For production use, replace with scikit-learn `Ridge` or an LSTM:

```python
from sklearn.linear_model import Ridge
import numpy as np

model = Ridge(alpha=1.0)
X = np.array([[d['influentFlow'], d['temperature'], d['pH'], d['alkalinity']] for d in history[:-1]])
y = np.array([d['biogasProduction'] for d in history[1:]])
model.fit(X, y)
next_pred = model.predict([[latest['influentFlow'], latest['temperature'], latest['pH'], latest['alkalinity']]])
```

---

## Dashboard Features

| Feature             | Description                                              |
|---------------------|----------------------------------------------------------|
| Overview Tab        | KPI cards + main charts + tag monitor                    |
| Process Tab         | Per-tag cards with mini sparklines and alarm limits      |
| Historian Tab       | Multi-tag time-series charts + data table                |
| AI Insights Tab     | Prediction panel + risk assessment + recommended actions |
| Controls Tab        | Feed rate slider + scenario presets + alarm log          |
| Live/Historical mode| Toggle between live stream and replay                    |
| Alarm system        | Auto-triggered on pH < 6.5, VFA/Alk > 0.3, CH₄ drops   |
| Digital twin        | Feed rate adjustments propagate through process model    |

---

## Alarm Logic

Alarms trigger on edge transitions (state machine — no repeated alerts):

- **CRITICAL**: pH < 6.5 (digester souring risk)
- **WARNING**: VFA/Alk > 0.3 (instability indicator)
- **WARNING**: CH₄ % < 58% (process health)
- **WARNING**: Temperature out of 32–40°C range

---

## Update Cadence

- Live refresh: every **2 seconds**
- Historian buffer: **120 points** (4 minutes in live mode)
- Backend historian: **3600 points** (2 hours at 2s intervals)
