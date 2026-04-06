"""
SuperSCADA - FastAPI Backend
Anaerobic Digestion SCADA System

Install: pip install fastapi uvicorn numpy
Run:     uvicorn main:app --reload --port 8000

Endpoints:
  GET /api/tags         - current tag snapshot
  GET /api/history      - last N readings
  GET /api/predict      - AI prediction for next timestep
  POST /api/control     - set operator parameters (feed_rate, etc.)
  WS  /ws/stream        - WebSocket live data stream (2s cadence)
"""

import asyncio
import random
import time
import math
from collections import deque
from typing import Optional
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import json

app = FastAPI(title="SuperSCADA API", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── TAG DEFINITIONS ──────────────────────────────────────────────────────────
TAGS = {
    "influentFlow":     {"id": "AD-FLOW-001", "unit": "m³/day", "min": 200,  "max": 600,  "nominal": 380},
    "temperature":      {"id": "AD-TEMP-001", "unit": "°C",     "min": 30,   "max": 42,   "nominal": 37},
    "pH":               {"id": "AD-PH-001",   "unit": "",       "min": 6.0,  "max": 8.0,  "nominal": 7.2},
    "alkalinity":       {"id": "AD-ALK-001",  "unit": "mg/L",   "min": 1500, "max": 4000, "nominal": 2800},
    "biogasProduction": {"id": "AD-GAS-001",  "unit": "m³/day", "min": 300,  "max": 900,  "nominal": 600},
    "methaneContent":   {"id": "AD-CH4-001",  "unit": "%",      "min": 55,   "max": 75,   "nominal": 65},
    "volatileSolids":   {"id": "AD-VS-001",   "unit": "kg/day", "min": 800,  "max": 2400, "nominal": 1400},
}

# ─── PROCESS MODEL ────────────────────────────────────────────────────────────
class DigesterModel:
    def __init__(self):
        self.state = {
            "influentFlow":     380.0,
            "temperature":      37.0,
            "pH":               7.2,
            "alkalinity":       2800.0,
            "biogasProduction": 600.0,
            "methaneContent":   65.0,
            "volatileSolids":   1400.0,
        }
        self.feed_rate = 1.0
        self.digester_volume = 5000  # m³

    def set_feed_rate(self, rate: float):
        self.feed_rate = max(0.3, min(2.0, rate))

    def _clamp(self, val, key):
        return max(TAGS[key]["min"], min(TAGS[key]["max"], val))

    def _noise(self, scale):
        return (random.random() - 0.5) * 2 * scale

    def tick(self):
        fr = self.feed_rate
        s = self.state

        s["influentFlow"] = self._clamp(
            s["influentFlow"] + self._noise(8) + (fr - 1) * 15, "influentFlow")

        temp_target = 36.5 + fr * 0.8
        s["temperature"] = self._clamp(
            s["temperature"] * 0.97 + temp_target * 0.03 + self._noise(0.15), "temperature")

        ph_target = 7.3 - (fr - 1) * 0.4 + (s["alkalinity"] - 2800) * 0.0001
        s["pH"] = self._clamp(
            s["pH"] * 0.95 + ph_target * 0.05 + self._noise(0.04), "pH")

        s["alkalinity"] = self._clamp(
            s["alkalinity"] + self._noise(30) - (fr - 1) * 20, "alkalinity")

        biogas_target = 600 * fr * (s["temperature"] / 37) * \
                        max(0.5, (s["pH"] - 6.2) / 1.0)
        s["biogasProduction"] = self._clamp(
            s["biogasProduction"] * 0.93 + biogas_target * 0.07 + self._noise(12),
            "biogasProduction")

        ch4_target = 65 + (s["temperature"] - 37) * 0.8 - \
                     max(0, (7.0 - s["pH"]) * 4)
        s["methaneContent"] = self._clamp(
            s["methaneContent"] * 0.96 + ch4_target * 0.04 + self._noise(0.3),
            "methaneContent")

        s["volatileSolids"] = self._clamp(
            s["volatileSolids"] + self._noise(25) + (fr - 1) * 60, "volatileSolids")

        return self._derive()

    def _derive(self):
        s = self.state
        olr = s["volatileSolids"] / self.digester_volume
        methane_yield = (s["biogasProduction"] * s["methaneContent"] / 100) / \
                        max(1, s["volatileSolids"] / 1000)
        vfa_estimate = max(50, 500 - s["alkalinity"] * 0.1 +
                           max(0, (7.2 - s["pH"]) * 300))
        vfa_alk_ratio = vfa_estimate / max(1, s["alkalinity"])
        energy_kwh = s["biogasProduction"] * (s["methaneContent"] / 100) * 9.97 * 0.40

        return {
            **{k: round(v, 3) for k, v in s.items()},
            "OLR":          round(olr, 4),
            "methaneYield": round(methane_yield, 3),
            "VFAEstimate":  round(vfa_estimate, 1),
            "VFAAlkRatio":  round(vfa_alk_ratio, 4),
            "energyKwh":    round(energy_kwh, 1),
            "timestamp":    time.time(),
        }


class ARPredictor:
    """Simple AR(1) + process physics predictor."""
    def predict(self, history: list) -> dict:
        if len(history) < 3:
            return {"error": "Insufficient history"}

        recent = history[-10:]

        def predict_val(key):
            vals = [d[key] for d in recent if key in d]
            if not vals:
                return 0
            mean = sum(vals) / len(vals)
            last = vals[-1]
            trend = (last - vals[0]) / len(vals)
            return last + trend * 0.5 + (mean - last) * 0.1

        next_biogas  = max(200, predict_val("biogasProduction"))
        next_ch4     = max(50,  predict_val("methaneContent"))
        next_ph      = max(5.5, predict_val("pH"))
        next_vfa_alk = max(0,   predict_val("VFAAlkRatio"))

        biogas_risk   = "HIGH" if next_biogas < 380 else "MEDIUM" if next_biogas < 480 else "LOW"
        vfa_risk      = "HIGH" if next_vfa_alk > 0.35 else "MEDIUM" if next_vfa_alk > 0.25 else "LOW"
        stability_risk= "HIGH" if next_ph < 6.6 else "MEDIUM" if next_ph < 6.9 else "LOW"

        actions = []
        if vfa_risk != "LOW":
            actions.append("Reduce feed rate by 10–15% to prevent VFA accumulation")
        if stability_risk != "LOW":
            actions.append("Add alkalinity supplement (NaHCO₃) — target 2500–3000 mg/L")
        if biogas_risk != "LOW":
            actions.append("Biogas declining — check influent VS concentration")
        if not actions:
            actions.append("System operating within optimal parameters")

        return {
            "biogasNext":     round(next_biogas, 1),
            "ch4Next":        round(next_ch4, 2),
            "phNext":         round(next_ph, 3),
            "vfaAlkNext":     round(next_vfa_alk, 4),
            "biogasRisk":     biogas_risk,
            "vfaRisk":        vfa_risk,
            "stabilityRisk":  stability_risk,
            "actions":        actions,
            "confidence":     min(95, 60 + len(history)),
            "model":          "AR(1)+ProcessPhysics",
        }


# ─── GLOBAL STATE ─────────────────────────────────────────────────────────────
model     = DigesterModel()
predictor = ARPredictor()
history   = deque(maxlen=3600)  # 1hr @ 1Hz
alarms    = deque(maxlen=200)
alarm_state = {}


def check_alarms(data: dict):
    now = time.strftime("%H:%M:%S")
    checks = [
        ("pH",     data["pH"],             6.5,  7.8,  "CRITICAL"),
        ("VFA",    data["VFAAlkRatio"],    -1,   0.30, "WARNING"),
        ("CH4",    data["methaneContent"], 58.0, 73.0, "WARNING"),
        ("TEMP",   data["temperature"],    32.0, 40.0, "WARNING"),
        ("FLOW",   data["influentFlow"],  150.0, 550.0,"INFO"),
    ]
    for tag, val, lo, hi, level in checks:
        state = alarm_state.get(tag, "ok")
        if lo > 0 and val < lo and state != "lo":
            alarms.appendleft({"tag": tag, "msg": f"{tag} LOW: {val:.2f}", "level": "CRITICAL", "time": now})
            alarm_state[tag] = "lo"
        elif val > hi and state != "hi":
            alarms.appendleft({"tag": tag, "msg": f"{tag} HIGH: {val:.2f}", "level": level, "time": now})
            alarm_state[tag] = "hi"
        elif (lo < 0 or val >= lo) and val <= hi:
            alarm_state[tag] = "ok"


# ─── BACKGROUND DATA TASK ─────────────────────────────────────────────────────
@app.on_event("startup")
async def start_engine():
    asyncio.create_task(data_loop())

async def data_loop():
    while True:
        data = model.tick()
        history.append(data)
        check_alarms(data)
        await asyncio.sleep(2)


# ─── REST ENDPOINTS ───────────────────────────────────────────────────────────
@app.get("/api/tags")
async def get_tags():
    """Current snapshot of all SCADA tags."""
    return list(history)[-1] if history else {}

@app.get("/api/history")
async def get_history(n: int = 120):
    """Last N historian readings."""
    return list(history)[-n:]

@app.get("/api/predict")
async def get_prediction():
    """AI prediction for next timestep."""
    return predictor.predict(list(history))

@app.get("/api/alarms")
async def get_alarms(n: int = 50):
    """Recent alarm log."""
    return list(alarms)[:n]

@app.get("/api/tags/definitions")
async def get_tag_definitions():
    """Tag metadata — IDs, units, limits."""
    return TAGS

class ControlInput(BaseModel):
    feed_rate: Optional[float] = None  # 0.3 – 2.0 (1.0 = 100%)

@app.post("/api/control")
async def set_control(ctrl: ControlInput):
    """Set operator control parameters."""
    if ctrl.feed_rate is not None:
        model.set_feed_rate(ctrl.feed_rate)
        return {"status": "ok", "feed_rate": model.feed_rate}
    return {"status": "no change"}

@app.get("/api/status")
async def get_status():
    """System health summary."""
    latest = list(history)[-1] if history else {}
    stability = "STABLE" if latest.get("VFAAlkRatio", 0) < 0.2 else \
                "CAUTION" if latest.get("VFAAlkRatio", 0) < 0.3 else "UNSTABLE"
    return {
        "status": stability,
        "feed_rate": model.feed_rate,
        "historian_size": len(history),
        "active_alarms": len(alarms),
        "uptime_s": int(len(history) * 2),
    }


# ─── WEBSOCKET LIVE STREAM ────────────────────────────────────────────────────
@app.websocket("/ws/stream")
async def websocket_stream(ws: WebSocket):
    """WebSocket endpoint for live SCADA data stream."""
    await ws.accept()
    try:
        while True:
            if history:
                payload = {
                    "type": "data",
                    "data": list(history)[-1],
                    "alarms": list(alarms)[:5],
                }
                await ws.send_text(json.dumps(payload))
            await asyncio.sleep(2)
    except Exception:
        pass
    finally:
        await ws.close()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
