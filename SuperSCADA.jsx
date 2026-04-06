import { useState, useEffect, useRef, useCallback } from "react";
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, RadarChart, Radar, PolarGrid, PolarAngleAxis } from "recharts";

// ─── NORTH RIVER WRRF — ENGINEERING BASIS (NYSDEC Permit NY0026247) ──────────
//  8 × 200,000 ft³ (5,663 m³) circular cast-in-place concrete digesters
//  Two-stage mesophilic · 170 MGD design · Riverbank State Park platform
//  HRT 15–20d · SRT 20–30d · Temp ≥95°F (35–37°C) · Wiggins 135k ft³ holder
//  5 × 3.37 MW cogen engines · 15 ft³ gas/lb VS destroyed (0.936 m³/kgVS)
// ─────────────────────────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════════════
//  PROCESS MODEL — NorthRiverModel
// ══════════════════════════════════════════════════════════════════════════════
class NorthRiverModel {
  constructor() {
    // Core process state
    this.s = {
      influentFlow: 580,      // m³/day — thickened sludge feed
      temperature:  35.8,     // °C     — mesophilic target 35–37°C
      pH:           7.05,     // —      — target 6.8–7.2
      alkalinity:   3100,     // mg/L CaCO₃
      biogasRate:   8400,     // m³/day
      methane:      64.2,     // % CH₄
      vsLoading:    16000,    // kg VS/day
      secLevel:     65,       // % — secondary digester fill
      mlss:         2500,     // mg/L — aeration basin
      // NEW microbial parameters
      vfa:          280,      // mg/L as HAc — direct measurement
      cod:          18500,    // mg/L — influent COD to digester
      tss:          42000,    // mg/L — total suspended solids in digester
      biomass:      28000,    // mg VSS/L — active biomass estimate
      nh3:          140,      // mg/L — free ammonia (inhibitor)
      sulfide:      18,       // mg/L total sulfide (inhibitor)
      heavyMetals:  0.12,     // normalized inhibition index 0–1
      toxicOrganics:0.08,     // normalized inhibition index 0–1
      // Nutrients (influent)
      tn:           45,       // mg/L total nitrogen (influent)
      tp:           8.5,      // mg/L total phosphorus (influent)
      cod_inf:      19500,    // mg/L COD in influent (≈ Carbon proxy)
    };

    // Autonomous control state
    this.feedRate        = 1.0;   // operator/AI multiplier
    this.wastingRate     = 1.0;   // sludge wasting rate multiplier
    this.bicarbonateDose = 0;     // kg NaHCO₃/day injected
    this.dilutionActive  = false; // dilution mitigation active
    this.autoMode        = true;  // AI autonomous control enabled
    this.aiActions       = [];    // log of AI interventions

    // Retention time tracking
    this.biomassInventory = 28000 * 22652 / 1000; // kg VSS total (mg/L × vol in m³)
    this.PRIMARY_VOL  = 4 * 5663; // m³
    this.TOTAL_VOL    = 8 * 5663;
    this.gasHolder    = 1800;
    this.GAS_HOLDER_MAX = 3822;

    // Inhibitor event history (for pattern recognition)
    this.inhibitorLog   = [];  // {type, severity, time}
    this.inhibitorEvents= { nh3:0, sulfide:0, heavyMetal:0, toxicOrg:0 };

    // Diurnal wastewater flow pattern
    this.diurnal = [0.82,0.78,0.75,0.74,0.76,0.83,0.92,1.05,1.15,1.18,1.16,1.14,
                    1.12,1.10,1.09,1.10,1.12,1.15,1.13,1.08,1.02,0.97,0.92,0.86];
    this.hour = new Date().getHours();
    this.step = 0;

    // Dose accumulator for alkalinity (resets each day-cycle)
    this.alkDoseAccum = 0;
    this.lastAutoAction = "";
  }

  setFeedRate(r)    { this.feedRate   = Math.max(0.3, Math.min(1.8, r)); }
  setWastingRate(r) { this.wastingRate = Math.max(0.4, Math.min(2.0, r)); }
  setAutoMode(b)    { this.autoMode   = b; }

  _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  _g(s) {
    const u = 1-Math.random(), v=1-Math.random();
    return Math.sqrt(-2*Math.log(u)) * Math.cos(2*Math.PI*v) * s;
  }

  // ── AI AUTONOMOUS CONTROL LOOP ────────────────────────────────────────────
  _autonomousControl() {
    const s = this.s;
    const actions = [];
    let feedAdj = 0, wasteAdj = 0, alkDose = 0, dilute = false;

    // 1. ALKALINITY DOSING — predictive pH/VFA response
    //    Trigger: pH trending toward 6.8 OR VFA/Alk > 0.2 OR alkalinity < 2600
    const vfaAlk = s.vfa / Math.max(1, s.alkalinity);
    if (this.autoMode) {
      if (s.pH < 6.95 || vfaAlk > 0.20 || s.alkalinity < 2600) {
        const alkDeficit = Math.max(0, 3000 - s.alkalinity);
        alkDose = Math.min(800, alkDeficit * 0.5 + (7.0 - s.pH) * 300);
        actions.push({ type:"dose", msg:`Auto-dosing NaHCO₃ ${alkDose.toFixed(0)} kg/d — pH ${fmt(s.pH,2)}, Alk ${fmt(s.alkalinity,0)} mg/L`, sev:"INFO" });
      } else {
        alkDose = 0;
      }

      // 2. FEED REDUCTION — VFA accumulation / inhibitor stress
      const inhibitorIdx = this._inhibitorIndex();
      if (vfaAlk > 0.30 || s.pH < 6.75 || inhibitorIdx > 0.35) {
        feedAdj = -Math.min(0.30, (vfaAlk - 0.20) * 0.8 + inhibitorIdx * 0.3);
        actions.push({ type:"feed", msg:`Feed reduced ${(Math.abs(feedAdj)*100).toFixed(0)}% — VFA/Alk ${vfaAlk.toFixed(3)}, Inhibitor idx ${inhibitorIdx.toFixed(2)}`, sev:"WARNING" });
      } else if (vfaAlk < 0.12 && s.pH > 7.0 && this.feedRate < 1.05) {
        feedAdj = Math.min(0.08, (1.1 - this.feedRate) * 0.5);
        if (feedAdj > 0.01) actions.push({ type:"feed", msg:`Conditions stable — incrementally increasing feed +${(feedAdj*100).toFixed(0)}%`, sev:"OK" });
      }

      // 3. DILUTION — inhibitor spike mitigation
      if (s.nh3 > 200 || s.sulfide > 35 || inhibitorIdx > 0.50) {
        dilute = true;
        actions.push({ type:"dilute", msg:`Dilution activated — NH₃ ${fmt(s.nh3,0)} mg/L, sulfide ${fmt(s.sulfide,1)} mg/L`, sev:"WARNING" });
      }

      // 4. SRT CONTROL — adjust wasting to maintain SRT 20–30d
      const srt = this._calcSRT();
      if (srt > 32) {
        wasteAdj = 0.15;
        actions.push({ type:"waste", msg:`SRT ${srt.toFixed(1)}d > 32d — increasing wasting rate`, sev:"INFO" });
      } else if (srt < 18) {
        wasteAdj = -0.12;
        actions.push({ type:"waste", msg:`SRT ${srt.toFixed(1)}d < 18d — reducing wasting, protect biomass`, sev:"WARNING" });
      }

      // 5. C:N:P RATIO ADJUSTMENT
      const cnp = this._cnpRatio();
      if (cnp.C_N > 25 || cnp.C_N < 15) {
        actions.push({ type:"nutrient", msg:`C:N ratio ${cnp.C_N.toFixed(1)} outside 20:1 target — ${cnp.C_N>25?"nitrogen supplement":"reduce N-loading"}`, sev:"INFO" });
      }

      // Apply adjustments
      if (feedAdj !== 0) this.feedRate = this._clamp(this.feedRate + feedAdj, 0.3, 1.8);
      if (wasteAdj !== 0) this.wastingRate = this._clamp(this.wastingRate + wasteAdj, 0.4, 2.0);
      this.bicarbonateDose = alkDose;
      this.dilutionActive  = dilute;
    }

    if (actions.length) {
      this.aiActions = [...actions, ...this.aiActions].slice(0, 40);
      this.lastAutoAction = actions[0].msg;
    }
    return actions;
  }

  _inhibitorIndex() {
    const s = this.s;
    const nh3Score    = Math.max(0, (s.nh3 - 100) / 300);       // >100 inhibitory, >400 severe
    const sulfScore   = Math.max(0, (s.sulfide - 10) / 80);      // >10 concerns, >90 severe
    const metalScore  = s.heavyMetals;
    const toxicScore  = s.toxicOrganics;
    return Math.min(1.0, nh3Score * 0.35 + sulfScore * 0.30 + metalScore * 0.20 + toxicScore * 0.15);
  }

  _calcSRT() {
    // SRT = biomass in system / (biomass wasted + biomass in effluent per day)
    const biomassTot   = this.s.biomass * this.PRIMARY_VOL; // mg VSS
    const wastingDaily = this.s.biomass * (this.s.influentFlow * 0.15) * this.wastingRate;
    return biomassTot / Math.max(1, wastingDaily);
  }

  _cnpRatio() {
    const s = this.s;
    // C expressed as COD equivalent: 1 g COD ≈ 1 g C organic for anaerobic processes
    const C = s.cod_inf;  // mg/L COD ≈ C source
    const N = s.tn;       // mg/L TN
    const P = s.tp;       // mg/L TP
    return {
      C_N:     C / Math.max(0.1, N),       // target ~20:1 for AD
      C_P:     C / Math.max(0.1, P),       // target ~100:1
      N_P:     N / Math.max(0.1, P),       // target ~5:1
      ratio:   `${(C/N).toFixed(0)}:${(N/P).toFixed(0)}:1`,
      status:  this._cnpStatus(C/N, N/P),
    };
  }

  _cnpStatus(cn, np) {
    if (cn > 28 || cn < 12) return "IMBALANCED";
    if (np > 7  || np < 3)  return "IMBALANCED";
    if (cn > 24 || cn < 16 || np > 6 || np < 4) return "MARGINAL";
    return "OPTIMAL";
  }

  _fmRatio() {
    // F/M = Food-to-Microorganism ratio
    // F = substrate loading (kg COD/day), M = active biomass (kg VSS)
    const F = (this.s.cod * this.s.influentFlow) / 1000; // kg COD/day
    const M = (this.s.biomass * this.PRIMARY_VOL) / 1e6; // kg VSS (mg/L × m³ = g → /1000 = kg)
    return F / Math.max(0.001, M);
  }

  tick() {
    this.step++;
    if (this.step % 30 === 0) this.hour = (this.hour + 1) % 24;

    const fr  = this.feedRate;
    const wr  = this.wastingRate;
    const diu = this.diurnal[this.hour];
    const s   = this.s;

    // ── AUTONOMOUS CONTROL (runs every tick) ──────────────────────────────
    const aiActs = this._autonomousControl();

    // Alkalinity boost from dosing
    const alkBoost = (this.bicarbonateDose / 3000) * 80; // simplified kg→mg/L effect
    // Dilution effect on concentrations
    const dilFactor = this.dilutionActive ? 0.92 : 1.0;

    // ── INFLUENT FLOW ────────────────────────────────────────────────────
    s.influentFlow = this._clamp(
      s.influentFlow * 0.91 + 580 * fr * (0.7 + 0.3*diu) * 0.09 + this._g(9),
      350, 900);

    // ── TEMPERATURE (35–37°C target) ─────────────────────────────────────
    const tempTgt = 36.0 * Math.min(1.05, fr);
    s.temperature = this._clamp(s.temperature * 0.987 + tempTgt * 0.013 + this._g(0.04), 33, 40);

    // ── NUTRIENTS C:N:P ───────────────────────────────────────────────────
    // COD influent varies with flow
    s.cod_inf = this._clamp(s.cod_inf * 0.93 + 19500 * diu * 0.07 + this._g(300), 14000, 28000);
    // TN — ammonia-rich municipal sludge
    s.tn  = this._clamp(s.tn * 0.95  + 45 * diu * 0.05 + this._g(2.5), 25, 80);
    // TP
    s.tp  = this._clamp(s.tp * 0.96  + 8.5 * diu * 0.04 + this._g(0.4), 4, 18);

    // ── VFA — DIRECT MEASUREMENT ──────────────────────────────────────────
    // VFA builds under overload; cleared by methanogenesis; pH and temp affect
    const vfaProduction = fr * 85 + (s.pH < 6.9 ? (6.9 - s.pH) * 120 : 0);
    const vfaConsumption= Math.max(0, (s.pH - 6.5) / 0.8) *
                          Math.max(0.3, (s.temperature - 33) / 4) * 90 *
                          (1 - this._inhibitorIndex() * 0.5);
    const vfaDelta = vfaProduction - vfaConsumption;
    s.vfa = this._clamp(s.vfa * 0.94 + (280 + vfaDelta) * 0.06 + this._g(8), 50, 2500);

    // ── COD (in-digester) ────────────────────────────────────────────────
    const codIn  = (s.cod_inf * s.influentFlow) / 1000; // kg/day
    const codRem = codIn * 0.62 * Math.max(0.4, (s.temperature-33)/4) *
                   Math.max(0.2, (s.pH-6.2)/1.0);
    s.cod = this._clamp(
      s.cod * 0.92 + ((codIn - codRem) / (this.PRIMARY_VOL/1000) * 1000) * 0.08 + this._g(200),
      8000, 35000);

    // ── pH — 6.8–7.2 TARGET ──────────────────────────────────────────────
    const stressLoad = Math.max(0, (fr - 1.0) * 0.55);
    const vfaAcid    = Math.max(0, (s.vfa - 300) * 0.0006);
    const alkEffect  = Math.max(0, (s.alkalinity - 2400) * 0.00008) + alkBoost * 0.003;
    const phTgt      = 7.02 - stressLoad - vfaAcid + alkEffect;
    s.pH = this._clamp(s.pH * 0.942 + phTgt * 0.058 + this._g(0.018), 6.2, 8.0);

    // ── ALKALINITY (bicarbonate dosing + natural buffer) ──────────────────
    const alkNatural  = -stressLoad * 40 + this._g(32);
    const alkDoseEff  = alkBoost;
    s.alkalinity = this._clamp(s.alkalinity + alkNatural + alkDoseEff, 1800, 5000);

    // ── AMMONIA (inhibitor) ───────────────────────────────────────────────
    // Increases with high N loading and pH (free ammonia); reduced by dilution
    const freeFraction = 1 / (1 + Math.pow(10, 9.25 - s.pH)); // Henderson-Hasselbalch approx
    s.nh3 = this._clamp(
      s.nh3 * 0.96 + (s.tn * freeFraction * 8 * diu * fr) * 0.04 + this._g(4),
      20, 600) * dilFactor;

    // ── SULFIDE (inhibitor) ───────────────────────────────────────────────
    // Produced by sulfate-reducing bacteria; pH-dependent speciation
    const sulfateLoad = fr * 0.8 + this._g(0.1);
    s.sulfide = this._clamp(
      s.sulfide * 0.97 + sulfateLoad * 4 * 0.03 + this._g(1.5),
      2, 120) * dilFactor;

    // ── HEAVY METALS index ───────────────────────────────────────────────
    // Episodic industrial discharge events (random spikes)
    if (Math.random() < 0.002) {
      s.heavyMetals = Math.min(1.0, s.heavyMetals + 0.15 + this._g(0.05));
      this.inhibitorEvents.heavyMetal++;
      this.inhibitorLog.push({ type:"Heavy Metal", time: new Date().toLocaleTimeString(), sev: s.heavyMetals > 0.4 ? "HIGH":"MEDIUM" });
    }
    s.heavyMetals = this._clamp(s.heavyMetals * 0.985 + this._g(0.005) * 0.01, 0, 1);

    // ── TOXIC ORGANICS index ─────────────────────────────────────────────
    if (Math.random() < 0.003) {
      s.toxicOrganics = Math.min(1.0, s.toxicOrganics + 0.12 + this._g(0.04));
      this.inhibitorEvents.toxicOrg++;
      this.inhibitorLog.push({ type:"Toxic Organics", time: new Date().toLocaleTimeString(), sev: "MEDIUM" });
    }
    s.toxicOrganics = this._clamp(s.toxicOrganics * 0.988 + this._g(0.004)*0.01, 0, 1);

    // ── VS LOADING ───────────────────────────────────────────────────────
    s.vsLoading = this._clamp(
      s.vsLoading * 0.91 + 16000 * fr * (0.82 + 0.18*diu) * 0.09 + this._g(180),
      8000, 25000);

    // ── BIOMASS — active methanogens ─────────────────────────────────────
    const muMax  = 0.40; // d⁻¹ mesophilic methanogen max growth
    const inhibIdx = this._inhibitorIndex();
    const muNet  = muMax * Math.max(0.1, (s.temperature-33)/4) *
                   Math.max(0.1, (s.pH-6.3)/1.0) *
                   Math.max(0.1, 1 - inhibIdx) -
                   (this.wastingRate * 0.035);
    // Per-tick biomass change (2-second tick = 2/86400 of a day)
    const dt = 2 / 86400;
    s.biomass = this._clamp(
      s.biomass * (1 + muNet * dt) + this._g(2),
      8000, 55000);

    // ── VS DESTRUCTION + BIOGAS ──────────────────────────────────────────
    const vsDestFrac = 0.57 * Math.max(0.4, 1 - stressLoad * 0.28) *
                       Math.max(0.3, 1 - inhibIdx * 0.6);
    const vsDestroyed = s.vsLoading * vsDestFrac;
    const tempFac = 0.78 + 0.22 * (s.temperature - 33) / 6;
    const phFac   = Math.max(0.2, Math.min(1.0, (s.pH - 6.2) / 1.0));
    const biogasTgt = vsDestroyed * 0.936 * tempFac * phFac;
    s.biogasRate = this._clamp(
      s.biogasRate * 0.925 + biogasTgt * 0.075 + this._g(75),
      4000, 12000);

    const ch4Tgt = 64.0 + (s.temperature - 35.5)*0.55 - Math.max(0,(7.0-s.pH)*2.2) - inhibIdx * 3;
    s.methane = this._clamp(s.methane * 0.965 + ch4Tgt * 0.035 + this._g(0.18), 55, 72);

    // ── SECONDARY DIGESTER + MLSS ─────────────────────────────────────────
    const fillR  = (s.influentFlow / 5663) * 2.3;
    const drainR = 1.75 + this._g(0.25);
    s.secLevel = this._clamp(s.secLevel + (fillR - drainR)*0.09 + this._g(0.35), 30, 95);
    s.mlss = this._clamp(s.mlss * 0.975 + (2500 * diu / fr) * 0.025 + this._g(28), 1500, 3500);

    // ── TSS ───────────────────────────────────────────────────────────────
    s.tss = this._clamp(s.biomass * 1.45 + this._g(500), 15000, 80000);

    // ── GAS HOLDER ────────────────────────────────────────────────────────
    const gp = s.biogasRate / 43200;
    this.gasHolder = this._clamp(this.gasHolder + (gp - gp*1.08), 80, this.GAS_HOLDER_MAX);

    return this._derive(vsDestroyed, aiActs);
  }

  _derive(vsDestroyed, aiActs) {
    const s = this.s;
    const OLR     = s.vsLoading / this.PRIMARY_VOL;
    const HRT     = this.PRIMARY_VOL / Math.max(1, s.influentFlow);
    const SRT     = this._calcSRT();
    const FM      = this._fmRatio();
    const cnp     = this._cnpRatio();
    const ch4V    = s.biogasRate * (s.methane / 100);
    const vfaAlkR = s.vfa / Math.max(1, s.alkalinity);
    const inhIdx  = this._inhibitorIndex();
    const microbialStress = this._microbialStressIndex();
    const elecKwh = ch4V * 9.97 * 0.35;
    const heatKwh = ch4V * 9.97 * 0.45;
    return {
      // Primary tags
      influentFlow:   +s.influentFlow.toFixed(0),
      temperature:    +s.temperature.toFixed(1),
      pH:             +s.pH.toFixed(2),
      alkalinity:     +s.alkalinity.toFixed(0),
      biogasRate:     +s.biogasRate.toFixed(0),
      methane:        +s.methane.toFixed(1),
      vsLoading:      +s.vsLoading.toFixed(0),
      secLevel:       +s.secLevel.toFixed(1),
      mlss:           +s.mlss.toFixed(0),
      // Microbial stress indicators
      vfa:            +s.vfa.toFixed(0),
      cod:            +s.cod.toFixed(0),
      tss:            +s.tss.toFixed(0),
      biomass:        +s.biomass.toFixed(0),
      FM:             +FM.toFixed(4),
      // C:N:P
      cod_inf:        +s.cod_inf.toFixed(0),
      tn:             +s.tn.toFixed(1),
      tp:             +s.tp.toFixed(1),
      cnpRatio:       cnp.ratio,
      cnpStatus:      cnp.status,
      C_N:            +cnp.C_N.toFixed(1),
      C_P:            +cnp.C_P.toFixed(1),
      N_P:            +cnp.N_P.toFixed(1),
      // Inhibitors
      nh3:            +s.nh3.toFixed(0),
      sulfide:        +s.sulfide.toFixed(1),
      heavyMetals:    +s.heavyMetals.toFixed(3),
      toxicOrganics:  +s.toxicOrganics.toFixed(3),
      inhibitorIndex: +inhIdx.toFixed(3),
      // Derived process
      OLR:            +OLR.toFixed(4),
      HRT:            +HRT.toFixed(1),
      SRT:            +SRT.toFixed(1),
      vsDestroyed:    +vsDestroyed.toFixed(0),
      ch4Volume:      +ch4V.toFixed(0),
      methaneYield:   +(ch4V/Math.max(1,vsDestroyed)).toFixed(4),
      vfaAlkRatio:    +vfaAlkR.toFixed(4),
      microbialStress:+microbialStress.toFixed(3),
      elecKwh:        +elecKwh.toFixed(0),
      heatKwh:        +heatKwh.toFixed(0),
      // Control state
      feedRate:       +this.feedRate.toFixed(3),
      wastingRate:    +this.wastingRate.toFixed(3),
      bicarbonateDose:+this.bicarbonateDose.toFixed(0),
      dilutionActive: this.dilutionActive,
      autoMode:       this.autoMode,
      // Gas holder
      gasHolderM3:    +this.gasHolder.toFixed(0),
      gasHolderPct:   +(this.gasHolder/this.GAS_HOLDER_MAX*100).toFixed(1),
      timestamp:      Date.now(),
      aiActions:      aiActs || [],
    };
  }

  _microbialStressIndex() {
    const s = this.s;
    const phStress   = Math.max(0, 1 - Math.abs(s.pH - 7.0) / 0.8) < 0.5
                       ? (1 - Math.max(0, (s.pH - 6.5)/0.7)) : 0;
    const tempStress = s.temperature < 35 ? (35 - s.temperature) / 5 : s.temperature > 37 ? (s.temperature - 37) / 3 : 0;
    const vfaStress  = Math.max(0, (s.vfa - 400) / 1500);
    const inhStress  = this._inhibitorIndex();
    return Math.min(1.0, (phStress*0.30 + tempStress*0.20 + vfaStress*0.25 + inhStress*0.25));
  }

  predict(history) {
    if (history.length < 3) return null;
    const r = history.slice(-15);
    const pv = k => {
      const vals = r.map(d => d[k]).filter(v => v != null);
      if (vals.length < 2) return vals[0] || 0;
      const trend = (vals[vals.length-1] - vals[0]) / vals.length;
      const mean  = vals.reduce((a,b)=>a+b,0) / vals.length;
      return vals[vals.length-1] + trend * 0.55 + (mean - vals[vals.length-1]) * 0.14;
    };
    const nB  = Math.max(4000, pv("biogasRate"));
    const nP  = Math.max(6.2,  pv("pH"));
    const nV  = Math.max(0,    pv("vfaAlkRatio"));
    const nF  = Math.max(0,    pv("FM"));
    const nI  = Math.max(0,    pv("inhibitorIndex"));
    const nMS = Math.max(0,    pv("microbialStress"));
    const nSRT= Math.max(5,    pv("SRT"));
    const bR  = nB < 5500 ? "HIGH" : nB < 7000 ? "MEDIUM" : "LOW";
    const vR  = nV > 0.30 ? "HIGH" : nV > 0.20 ? "MEDIUM" : "LOW";
    const sR  = nP < 6.6  ? "HIGH" : nP < 6.9  ? "MEDIUM" : "LOW";
    const iR  = nI > 0.45 ? "HIGH" : nI > 0.25 ? "MEDIUM" : "LOW";
    const mR  = nMS > 0.5 ? "HIGH" : nMS > 0.3  ? "MEDIUM" : "LOW";
    const fmR = nF > 0.8  ? "HIGH" : nF > 0.5   ? "MEDIUM" : "LOW";
    const srtR= nSRT < 15 ? "HIGH" : nSRT > 35 ? "MEDIUM" : "LOW";
    const actions = [];
    if (vR !== "LOW") actions.push({ cat:"VFA/pH", sev:vR, msg:"VFA accumulation trend detected — alkalinity dosing initiated, feed reduction recommended" });
    if (sR !== "LOW") actions.push({ cat:"pH",     sev:sR, msg:`pH ${nP.toFixed(2)} approaching acidification — NaHCO₃ dose ${nP < 6.8 ? "800":"400"} kg/d, monitor alkalinity response` });
    if (iR !== "LOW") actions.push({ cat:"Inhibitor",sev:iR,msg:"Inhibitor accumulation detected — dilution and reduced loading recommended; assess CSO events" });
    if (mR !== "LOW") actions.push({ cat:"Microbes",sev:mR, msg:"Microbial stress index elevated — protect biomass: reduce wasting, verify temp 35–37°C, check nutrients" });
    if (fmR !== "LOW") actions.push({ cat:"F/M",   sev:fmR, msg:`F/M ratio ${nF.toFixed(3)} elevated — substrate excess relative to biomass; step down feed rate` });
    if (srtR === "HIGH") actions.push({ cat:"SRT",   sev:"HIGH", msg:`SRT ${nSRT.toFixed(1)}d critically short — reduce sludge wasting immediately to protect methanogen population` });
    if (!actions.length) actions.push({ cat:"System",sev:"LOW", msg:"All microbial indicators nominal — operating within optimal envelope for North River mesophilic digestion" });
    return {
      biogasNext:nB.toFixed(0), phNext:nP.toFixed(2), vfaAlkNext:nV.toFixed(4),
      fmNext:nF.toFixed(3), inhibNext:nI.toFixed(3), stressNext:nMS.toFixed(3), srtNext:nSRT.toFixed(1),
      biogasRisk:bR, vfaRisk:vR, stabilityRisk:sR, inhibRisk:iR, stressRisk:mR, fmRisk:fmR, srtRisk:srtR,
      actions, confidence: Math.min(96, 50 + history.length * 0.9),
    };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  HELPERS & CONSTANTS
// ══════════════════════════════════════════════════════════════════════════════
const engine = new NorthRiverModel();
const fmt  = (v, d=1) => typeof v === "number" ? v.toFixed(d) : "—";
const ts   = t => new Date(t).toLocaleTimeString("en-US",{hour12:false});
const HIST = 120;
const rc   = r => r==="HIGH"?"#f87171":r==="MEDIUM"?"#fbbf24":"#4ade80";

const HEALTH_RANGES = {
  pH:           { lo:6.8, hi:7.2, label:"pH 6.8–7.2" },
  temperature:  { lo:35,  hi:37,  label:"35–37°C" },
  vfa:          { lo:0,   hi:500, label:"<500 mg/L" },
  FM:           { lo:0,   hi:0.5, label:"<0.5 g COD/gVSS·d" },
  nh3:          { lo:0,   hi:200, label:"<200 mg/L free NH₃" },
  sulfide:      { lo:0,   hi:35,  label:"<35 mg/L total" },
  SRT:          { lo:15,  hi:35,  label:"15–35 days" },
  HRT:          { lo:15,  hi:20,  label:"15–20 days" },
};

const paramColor = (v, key) => {
  const r = HEALTH_RANGES[key];
  if (!r) return "#4ade80";
  if (v < r.lo || v > r.hi) return "#f87171";
  const margin = (r.hi - r.lo) * 0.12;
  if (v < r.lo + margin || v > r.hi - margin) return "#fbbf24";
  return "#4ade80";
};

const CC = {
  biogasRate:"#facc15", methane:"#60a5fa", pH:"#a78bfa", temperature:"#fb923c",
  alkalinity:"#34d399", vfa:"#f87171", cod:"#f97316", FM:"#e879f9",
  nh3:"#fca5a5", sulfide:"#fde68a", inhibitorIndex:"#f87171", microbialStress:"#fb7185",
  OLR:"#fbbf24", HRT:"#818cf8", SRT:"#c4b5fd", ch4Volume:"#67e8f9",
  biomass:"#86efac", C_N:"#38bdf8", gasHolderPct:"#6ee7b7",
};

// ══════════════════════════════════════════════════════════════════════════════
//  UI COMPONENTS
// ══════════════════════════════════════════════════════════════════════════════
function KPI({ label, value, unit, sub, color, pulse, warn }) {
  return (
    <div style={{ background:"rgba(6,15,36,.88)", border:`1px solid ${warn?"#f87171":color}35`, borderRadius:10, padding:"11px 13px", position:"relative", overflow:"hidden", minWidth:0 }}>
      <div style={{ position:"absolute", top:0, left:0, right:0, height:2, background:warn?"#f87171":color, opacity:pulse?1:.5, animation:pulse?"pulseBar 1.4s ease-in-out infinite":"none" }} />
      <div style={{ fontSize:9, color:"#334155", letterSpacing:".09em", textTransform:"uppercase", marginBottom:3, fontFamily:"monospace", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{label}</div>
      <div style={{ fontSize:21, fontWeight:700, color:warn?"#f87171":color, fontFamily:"'Courier New',monospace", lineHeight:1 }}>
        {value}<span style={{ fontSize:9, fontWeight:400, color:"#475569", marginLeft:3 }}>{unit}</span>
      </div>
      {sub && <div style={{ fontSize:9, color:"#334155", marginTop:2, fontFamily:"monospace", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{sub}</div>}
    </div>
  );
}

function GaugeBar({ label, value, lo, hi, unit, color, decimals=1 }) {
  const pct = Math.min(100, Math.max(0, ((value - lo) / (hi - lo)) * 100));
  const ok  = value >= lo && value <= hi;
  const c   = ok ? color : "#f87171";
  return (
    <div style={{ marginBottom:10 }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
        <span style={{ fontSize:10, color:"#475569", fontFamily:"monospace" }}>{label}</span>
        <span style={{ fontSize:13, fontWeight:700, color:c, fontFamily:"monospace" }}>
          {fmt(value, decimals)} <span style={{ fontSize:9, color:"#334155" }}>{unit}</span>
        </span>
      </div>
      <div style={{ position:"relative", background:"#040d1c", borderRadius:4, height:7 }}>
        <div style={{ width:`${pct}%`, height:"100%", borderRadius:4, background:c, transition:"width .4s ease" }} />
        {lo > 0 && <div style={{ position:"absolute", top:-2, bottom:-2, left:"0%", width:1, background:"#4ade8040" }} />}
        <div style={{ position:"absolute", top:-2, bottom:-2, left:"100%", width:1, background:"#f8717140" }} />
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", marginTop:2, fontSize:8, color:"#1e3a5f" }}>
        <span>{fmt(lo, decimals)}</span><span style={{ color:ok?"#4ade8080":"#f8717180" }}>TARGET</span><span>{fmt(hi, decimals)}</span>
      </div>
    </div>
  );
}

function AlarmLine({ msg, level, time, cat }) {
  const c = level==="CRITICAL"?"#f87171":level==="WARNING"?"#fbbf24":level==="HIGH"?"#f87171":level==="MEDIUM"?"#fbbf24":"#4ade80";
  return (
    <div style={{ padding:"6px 10px", borderRadius:6, marginBottom:4, background:`${c}10`, borderLeft:`2px solid ${c}`, fontSize:11, fontFamily:"monospace", display:"flex", gap:8, alignItems:"flex-start" }}>
      {cat && <span style={{ background:`${c}25`, color:c, borderRadius:4, padding:"1px 6px", fontSize:9, fontWeight:700, whiteSpace:"nowrap", alignSelf:"center" }}>{cat}</span>}
      <span style={{ color:"#94a3b8", flex:1, lineHeight:1.4 }}>{msg}</span>
      <span style={{ color:"#334155", fontSize:9, whiteSpace:"nowrap" }}>{time}</span>
    </div>
  );
}

function Head({ icon, children }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:8, fontSize:10, fontWeight:700, letterSpacing:".11em", color:"#1e3a5f", textTransform:"uppercase", marginBottom:12, borderBottom:"1px solid #050f22", paddingBottom:7, fontFamily:"monospace" }}>
      <span style={{ color:"#38bdf8" }}>{icon}</span>{children}
    </div>
  );
}

function Spark({ data, k, color, h=72, lo, hi }) {
  return (
    <ResponsiveContainer width="100%" height={h}>
      <AreaChart data={data.slice(-40)} margin={{top:3,right:2,left:-34,bottom:0}}>
        <defs><linearGradient id={`sg-${k}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.35}/>
          <stop offset="100%" stopColor={color} stopOpacity={0.02}/>
        </linearGradient></defs>
        <XAxis dataKey="timestamp" hide/><YAxis hide domain={["auto","auto"]}/>
        {hi && <ReferenceLine y={hi} stroke="#f87171" strokeDasharray="2 3" strokeWidth={0.7}/>}
        {lo && lo > 0 && <ReferenceLine y={lo} stroke="#fbbf24" strokeDasharray="2 3" strokeWidth={0.7}/>}
        <Area type="monotone" dataKey={k} stroke={color} strokeWidth={1.5} fill={`url(#sg-${k})`} dot={false} isAnimationActive={false}/>
      </AreaChart>
    </ResponsiveContainer>
  );
}

function StatusBadge({ label, status }) {
  const c = status==="OPTIMAL"||status==="LOW"?"#4ade80":status==="MARGINAL"||status==="MEDIUM"?"#fbbf24":"#f87171";
  return (
    <div style={{ display:"inline-flex", alignItems:"center", gap:6, background:`${c}15`, border:`1px solid ${c}35`, borderRadius:6, padding:"3px 8px" }}>
      <div style={{ width:5, height:5, borderRadius:"50%", background:c }} />
      <span style={{ fontSize:10, fontWeight:700, color:c, fontFamily:"monospace", letterSpacing:".06em" }}>{label}: {status}</span>
    </div>
  );
}

function CNPGauge({ data }) {
  if (!data) return null;
  const c_n_ok = data.C_N >= 15 && data.C_N <= 25;
  const n_p_ok = data.N_P >= 3  && data.N_P <= 7;
  const c  = data.cnpStatus==="OPTIMAL"?"#4ade80":data.cnpStatus==="MARGINAL"?"#fbbf24":"#f87171";
  const barStyle = (val, lo, hi, max) => ({
    width: `${Math.min(100,(val/max)*100)}%`, height:"100%", borderRadius:4,
    background: val>=lo&&val<=hi?"#4ade80":"#f87171", transition:"width .5s ease",
  });
  return (
    <div style={{ background:"#030812", borderRadius:10, padding:"14px", border:`1px solid ${c}30` }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
        <span style={{ fontSize:10, color:"#475569", letterSpacing:".1em", fontFamily:"monospace" }}>C : N : P RATIO</span>
        <StatusBadge label="Status" status={data.cnpStatus} />
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:12 }}>
        {[
          { lbl:"C:N Ratio", val:data.C_N, target:"~20:1", lo:15, hi:25, max:40, unit:"C/N" },
          { lbl:"C:P Ratio", val:data.C_P, target:"~100:1", lo:70, hi:130, max:200, unit:"C/P" },
          { lbl:"N:P Ratio", val:data.N_P, target:"~5:1",  lo:3,  hi:7,   max:12,  unit:"N/P" },
        ].map(({lbl,val,target,lo,hi,max,unit}) => {
          const ok = val>=lo&&val<=hi;
          return (
            <div key={lbl} style={{ background:"#06142e", borderRadius:8, padding:"10px" }}>
              <div style={{ fontSize:9, color:"#334155", marginBottom:3, fontFamily:"monospace" }}>{lbl}</div>
              <div style={{ fontSize:20, fontWeight:700, fontFamily:"monospace", color:ok?"#4ade80":"#f87171" }}>
                {fmt(val,1)}<span style={{ fontSize:9, color:"#334155", marginLeft:3 }}>{unit}</span>
              </div>
              <div style={{ background:"#0a1628", borderRadius:3, height:4, margin:"6px 0" }}>
                <div style={barStyle(val,lo,hi,max)} />
              </div>
              <div style={{ fontSize:8, color:"#334155" }}>Target {target}</div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize:10, color:"#334155", fontFamily:"monospace" }}>
        Current ratio: <span style={{ color:c, fontWeight:700 }}>{data.cnpRatio}</span>
        <span style={{ color:"#1e3a5f", marginLeft:8 }}>— Target: 100:5:1</span>
      </div>
    </div>
  );
}

function InhibitorPanel({ data, log }) {
  const inhibitors = [
    { key:"nh3",          label:"Free Ammonia",   value:data.nh3,          unit:"mg/L",   lo:0,   hi:200,  warn:200, crit:400, desc:"Free NH₃ inhibits methanogens >200 mg/L. pH-dependent — rises with alkaline pH." },
    { key:"sulfide",      label:"Total Sulfide",  value:data.sulfide,      unit:"mg/L",   lo:0,   hi:35,   warn:35,  crit:80,  desc:"H₂S is toxic to methanogens >35 mg/L. pH-dependent free fraction is more inhibitory." },
    { key:"heavyMetals",  label:"Heavy Metals",   value:data.heavyMetals*100,unit:"%",   lo:0,   hi:15,   warn:30,  crit:60,  desc:"Industrial discharge events. Cu, Zn, Ni most inhibitory. Monitor via composite sampling." },
    { key:"toxicOrganics",label:"Toxic Organics", value:data.toxicOrganics*100,unit:"%", lo:0,   hi:15,   warn:30,  crit:60,  desc:"Halogenated compounds, detergents, solvents. Episodic industrial/CSO events." },
  ];
  const eventCounts = [
    { lbl:"NH₃ Events",    n:engine.inhibitorEvents.nh3 },
    { lbl:"Sulfide Events",n:engine.inhibitorEvents.sulfide },
    { lbl:"Metal Events",  n:engine.inhibitorEvents.heavyMetal },
    { lbl:"Toxic Events",  n:engine.inhibitorEvents.toxicOrg },
  ];
  return (
    <div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:12 }}>
        {inhibitors.map(({ key, label, value, unit, warn, crit, desc }) => {
          const c = value >= crit ? "#f87171" : value >= warn ? "#fbbf24" : "#4ade80";
          const pct = Math.min(100, (value / crit) * 70);
          return (
            <div key={key} style={{ background:"#030812", borderRadius:8, padding:"10px 12px", border:`1px solid ${c}25` }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:5 }}>
                <span style={{ fontSize:10, color:"#475569", fontFamily:"monospace" }}>{label}</span>
                <span style={{ fontSize:14, fontWeight:700, color:c, fontFamily:"monospace" }}>{fmt(value,1)} <span style={{ fontSize:9 }}>{unit}</span></span>
              </div>
              <div style={{ background:"#06142e", borderRadius:3, height:5, marginBottom:5 }}>
                <div style={{ width:`${pct}%`, height:"100%", borderRadius:3, background:c, transition:"width .5s ease" }} />
              </div>
              <div style={{ fontSize:9, color:"#1e3a5f", lineHeight:1.4 }}>{desc}</div>
            </div>
          );
        })}
      </div>
      <div style={{ background:"#030812", borderRadius:8, padding:"10px 12px", marginBottom:10 }}>
        <div style={{ fontSize:9, color:"#334155", letterSpacing:".08em", marginBottom:8, fontFamily:"monospace" }}>INHIBITOR EVENT COUNTER (SESSION)</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:8 }}>
          {eventCounts.map(({lbl,n})=>(
            <div key={lbl} style={{ textAlign:"center" }}>
              <div style={{ fontSize:22, fontWeight:700, color:n>3?"#f87171":n>0?"#fbbf24":"#4ade80", fontFamily:"monospace" }}>{n}</div>
              <div style={{ fontSize:9, color:"#334155" }}>{lbl}</div>
            </div>
          ))}
        </div>
      </div>
      {log.length > 0 && (
        <div style={{ background:"#030812", borderRadius:8, padding:"10px 12px" }}>
          <div style={{ fontSize:9, color:"#334155", letterSpacing:".08em", marginBottom:6, fontFamily:"monospace" }}>RECENT INHIBITOR EVENTS</div>
          {log.slice(-6).reverse().map((e,i) => (
            <div key={i} style={{ fontSize:10, color:e.sev==="HIGH"?"#f87171":"#fbbf24", fontFamily:"monospace", marginBottom:3 }}>
              [{e.sev}] {e.type} — {e.time}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MicrobialRadar({ data }) {
  if (!data) return null;
  // Normalize all to 0–100 "health" score (100 = perfect)
  const phHealth    = Math.max(0, 100 - Math.abs(data.pH - 7.0) * 60);
  const tempHealth  = Math.max(0, 100 - Math.abs(data.temperature - 36) * 25);
  const vfaHealth   = Math.max(0, 100 - (data.vfa / 600) * 80);
  const fmHealth    = Math.max(0, 100 - (data.FM / 0.8) * 80);
  const inhHealth   = Math.max(0, 100 - data.inhibitorIndex * 120);
  const cnpHealth   = data.cnpStatus==="OPTIMAL"?95:data.cnpStatus==="MARGINAL"?65:35;
  const srtHealth   = data.SRT>=15&&data.SRT<=35 ? 90 : Math.max(0,100-Math.abs(data.SRT-25)*4);
  const radarData = [
    { axis:"pH",         val: +phHealth.toFixed(0) },
    { axis:"Temp",       val: +tempHealth.toFixed(0) },
    { axis:"VFA",        val: +vfaHealth.toFixed(0) },
    { axis:"F/M",        val: +fmHealth.toFixed(0) },
    { axis:"Inhibitors", val: +inhHealth.toFixed(0) },
    { axis:"C:N:P",      val: +cnpHealth.toFixed(0) },
    { axis:"SRT",        val: +srtHealth.toFixed(0) },
  ];
  const overall = radarData.reduce((a,b)=>a+b.val,0)/radarData.length;
  const oColor  = overall > 75 ? "#4ade80" : overall > 50 ? "#fbbf24" : "#f87171";
  return (
    <div style={{ background:"#030812", borderRadius:10, padding:"14px", border:`1px solid ${oColor}25` }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
        <span style={{ fontSize:10, color:"#334155", letterSpacing:".1em", fontFamily:"monospace" }}>MICROBIAL HEALTH RADAR</span>
        <span style={{ fontSize:18, fontWeight:700, color:oColor, fontFamily:"monospace" }}>{overall.toFixed(0)}<span style={{ fontSize:9, color:"#475569", marginLeft:3 }}>/100</span></span>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <RadarChart data={radarData} margin={{top:10,right:30,left:30,bottom:10}}>
          <PolarGrid stroke="#0f2744" />
          <PolarAngleAxis dataKey="axis" tick={{ fill:"#334155", fontSize:10, fontFamily:"monospace" }} />
          <Radar dataKey="val" stroke={oColor} fill={oColor} fillOpacity={0.15} strokeWidth={1.5} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

function AutoControlPanel({ data, onFeedChange, onWasteChange, onAutoToggle, feedRate, wastingRate, autoMode }) {
  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
        <span style={{ fontSize:10, color:"#475569", letterSpacing:".1em", fontFamily:"monospace" }}>AUTONOMOUS CONTROL MODE</span>
        <button onClick={onAutoToggle} style={{
          background:autoMode?"#4ade8018":"#f8717118",
          border:`1px solid ${autoMode?"#4ade80":"#f87171"}50`,
          color:autoMode?"#4ade80":"#f87171",
          borderRadius:6, padding:"4px 12px", cursor:"pointer",
          fontSize:10, fontWeight:700, fontFamily:"monospace", letterSpacing:".08em",
        }}>{autoMode?"AI AUTO ◉":"MANUAL ◎"}</button>
      </div>

      {autoMode && (
        <div style={{ background:"#030e00", border:"1px solid #4ade8025", borderRadius:8, padding:"8px 12px", marginBottom:14, fontSize:10, color:"#4ade80" }}>
          ◉ AI is actively controlling feed rate, sludge wasting, alkalinity dosing, and dilution
        </div>
      )}

      {/* Alkalinity dosing status */}
      <div style={{ background:"#030812", borderRadius:8, padding:"10px 12px", marginBottom:10 }}>
        <div style={{ fontSize:9, color:"#334155", marginBottom:6, letterSpacing:".08em" }}>BICARBONATE DOSING (NaHCO₃)</div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontSize:20, fontWeight:700, color:data.bicarbonateDose>0?"#34d399":"#334155", fontFamily:"monospace" }}>
              {fmt(data.bicarbonateDose, 0)} <span style={{ fontSize:10, color:"#475569" }}>kg/day</span>
            </div>
            <div style={{ fontSize:9, color:"#1e3a5f", marginTop:2 }}>
              {data.bicarbonateDose > 0 ? `Dosing active — pH ${fmt(data.pH,2)}, Alk ${fmt(data.alkalinity,0)} mg/L` : "No dosing required — alkalinity sufficient"}
            </div>
          </div>
          <div style={{ width:50, height:50, borderRadius:"50%", border:`3px solid ${data.bicarbonateDose>0?"#34d399":"#1e3a5f"}`, display:"flex", alignItems:"center", justifyContent:"center" }}>
            <div style={{ fontSize:9, textAlign:"center", color:data.bicarbonateDose>0?"#34d399":"#334155", fontFamily:"monospace", lineHeight:1.2 }}>
              {data.bicarbonateDose>0?"ACTIVE":"IDLE"}
            </div>
          </div>
        </div>
      </div>

      {/* Dilution status */}
      <div style={{ background:"#030812", borderRadius:8, padding:"10px 12px", marginBottom:10, border:`1px solid ${data.dilutionActive?"#fbbf2430":"transparent"}` }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontSize:9, color:"#334155", marginBottom:4, letterSpacing:".08em" }}>DILUTION MITIGATION</div>
            <div style={{ fontSize:13, fontWeight:700, color:data.dilutionActive?"#fbbf24":"#334155", fontFamily:"monospace" }}>
              {data.dilutionActive?"ACTIVE — INHIBITOR SUPPRESSION":"STANDBY"}
            </div>
            <div style={{ fontSize:9, color:"#1e3a5f", marginTop:2 }}>NH₃ {fmt(data.nh3,0)} mg/L · H₂S {fmt(data.sulfide,1)} mg/L</div>
          </div>
        </div>
      </div>

      {/* Manual override sliders */}
      {!autoMode && (<>
        <div style={{ marginBottom:18 }}>
          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
            <span style={{ fontSize:10, color:"#64748b" }}>Feed Rate</span>
            <span style={{ fontSize:16, fontWeight:700, fontFamily:"monospace", color:feedRate>1.3?"#f87171":feedRate<0.7?"#fbbf24":"#4ade80" }}>{(feedRate*100).toFixed(0)}%</span>
          </div>
          <input type="range" min={30} max={180} value={feedRate*100} step={5} onChange={e=>onFeedChange(e.target.value/100)} />
        </div>
        <div style={{ marginBottom:16 }}>
          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
            <span style={{ fontSize:10, color:"#64748b" }}>Sludge Wasting Rate</span>
            <span style={{ fontSize:16, fontWeight:700, fontFamily:"monospace", color:"#818cf8" }}>{(wastingRate*100).toFixed(0)}%</span>
          </div>
          <input type="range" min={40} max={200} value={wastingRate*100} step={5} onChange={e=>onWasteChange(e.target.value/100)} />
        </div>
      </>)}

      {/* Live control state */}
      <div style={{ background:"#030812", borderRadius:8, padding:"10px 12px" }}>
        <div style={{ fontSize:9, color:"#334155", marginBottom:8, letterSpacing:".08em" }}>CURRENT CONTROL STATE</div>
        {[
          ["Feed Rate",       `${(data.feedRate*100).toFixed(0)}%`,  data.feedRate<0.85||data.feedRate>1.15],
          ["Wasting Rate",    `${(data.wastingRate*100).toFixed(0)}%`,false],
          ["SRT",             `${fmt(data.SRT,1)} d`,               data.SRT<15||data.SRT>35],
          ["HRT",             `${fmt(data.HRT,1)} d`,               data.HRT<15||data.HRT>20],
          ["Alk Dose",        `${fmt(data.bicarbonateDose,0)} kg/d`, false],
          ["NaHCO₃ / pH",    `pH ${fmt(data.pH,2)} → target 6.8–7.2`, data.pH<6.8||data.pH>7.2],
        ].map(([k,v,warn])=>(
          <div key={k} style={{ display:"flex", justifyContent:"space-between", marginBottom:5 }}>
            <span style={{ fontSize:10, color:"#334155" }}>{k}</span>
            <span style={{ fontSize:10, fontWeight:600, fontFamily:"monospace", color:warn?"#fbbf24":"#64748b" }}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  MAIN DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════
export default function SuperSCADA() {
  const [data,      setData]      = useState(null);
  const [history,   setHistory]   = useState([]);
  const [alarms,    setAlarms]    = useState([]);
  const [pred,      setPred]      = useState(null);
  const [tab,       setTab]       = useState("overview");
  const [paused,    setPaused]    = useState(false);
  const [feedRate,  setFeedRate]  = useState(1.0);
  const [wastRate,  setWastRate]  = useState(1.0);
  const [autoMode,  setAutoMode]  = useState(true);
  const [liveMode,  setLiveMode]  = useState(true);
  const [tick,      setTick]      = useState(0);
  const [inhibLog,  setInhibLog]  = useState([]);
  const aRef = useRef({});
  const iRef = useRef(null);
  const TT = { contentStyle:{background:"#060f24",border:"1px solid #0f2744",borderRadius:6,fontSize:10}, itemStyle:{fontFamily:"monospace"}, labelStyle:{color:"#334155"} };

  const runTick = useCallback(() => {
    const d = engine.tick();
    setData(d);
    setHistory(h => { const n=[...h,{...d,timestamp:ts(d.timestamp)}]; return n.length>HIST?n.slice(-HIST):n; });
    setTick(t=>t+1);
    setInhibLog([...engine.inhibitorLog]);

    const now = new Date().toLocaleTimeString("en-US",{hour12:false});
    const newA = [];
    const chk = (k,lbl,v,lo,hi,lvl="WARNING",cat="") => {
      const cur = aRef.current[k]||"ok";
      if (v<lo&&cur!=="lo") { newA.push({msg:`${lbl} LOW → ${fmt(v,2)}`,level:"CRITICAL",time:now,cat}); aRef.current[k]="lo"; }
      else if (v>hi&&cur!=="hi") { newA.push({msg:`${lbl} HIGH → ${fmt(v,2)}`,level:lvl,time:now,cat}); aRef.current[k]="hi"; }
      else if (v>=lo&&v<=hi) aRef.current[k]="ok";
    };
    chk("ph",   "pH",              d.pH,             6.5,  7.8,  "CRITICAL","pH");
    chk("vfa",  "VFA",             d.vfa,            0,    800,  "WARNING", "VFA");
    chk("ch4",  "Methane %",       d.methane,        60,   70,   "WARNING", "Gas");
    chk("temp", "Temperature",     d.temperature,    34,   39,   "WARNING", "Temp");
    chk("nh3",  "Free Ammonia",    d.nh3,            0,    200,  "WARNING", "Inhibitor");
    chk("h2s",  "Sulfide",         d.sulfide,        0,    35,   "WARNING", "Inhibitor");
    chk("srt",  "SRT",             d.SRT,            12,   38,   "WARNING", "SRT");
    chk("hrt",  "HRT",             d.HRT,            13,   22,   "WARNING", "HRT");
    chk("inhib","Inhibitor Index", d.inhibitorIndex, 0,    0.45, "WARNING", "Inhibitor");
    chk("gas",  "Biogas",          d.biogasRate,     5000, 11500,"WARNING", "Gas");
    // Forward AI actions as alarms
    if (d.aiActions && d.aiActions.length) {
      d.aiActions.forEach(a => {
        if (!newA.find(x=>x.msg===a.msg))
          newA.push({ msg:a.msg, level:a.sev==="WARNING"?"WARNING":a.sev==="HIGH"?"CRITICAL":"INFO", time:now, cat:"AI" });
      });
    }
    if (newA.length) setAlarms(a=>[...newA,...a].slice(0,60));
  }, []);

  useEffect(()=>{ if(history.length>5) setPred(engine.predict(history)); },[tick]);
  useEffect(()=>{
    if(!paused&&liveMode) iRef.current=setInterval(runTick,2000);
    else clearInterval(iRef.current);
    return ()=>clearInterval(iRef.current);
  },[paused,liveMode,runTick]);
  useEffect(()=>{ if(!autoMode) engine.setFeedRate(feedRate); },[feedRate,autoMode]);
  useEffect(()=>{ if(!autoMode) engine.setWastingRate(wastRate); },[wastRate,autoMode]);
  useEffect(()=>{ engine.setAutoMode(autoMode); },[autoMode]);
  useEffect(()=>{ runTick(); },[]);

  if (!data) return <div style={{background:"#020c1b",color:"#38bdf8",height:"100vh",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"monospace",fontSize:13}}>INITIALIZING NORTH RIVER WRRF — MICROBIAL INTELLIGENCE LAYER...</div>;

  const stability = data.microbialStress < 0.25 ? "STABLE" : data.microbialStress < 0.50 ? "CAUTION" : "UNSTABLE";
  const sC  = stability==="STABLE"?"#4ade80":stability==="CAUTION"?"#fbbf24":"#f87171";
  const critN = alarms.filter(a=>a.level==="CRITICAL").length;
  const TABS  = ["overview","microbial","inhibitors","nutrients","retention","ai-control","historian"];

  return (
    <div style={{ background:"#020c1b", minHeight:"100vh", color:"#e2e8f0", fontFamily:"'Courier New',monospace", fontSize:13 }}>
      <style>{`
        @keyframes pulseBar{0%,100%{opacity:.45}50%{opacity:1}}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:.18}}
        ::-webkit-scrollbar{width:3px;background:#020c1b}::-webkit-scrollbar-thumb{background:#0f2744;border-radius:2px}
        .tb{background:none;border:none;cursor:pointer;padding:7px 12px;font-family:monospace;font-size:10px;letter-spacing:.07em;text-transform:uppercase;border-bottom:2px solid transparent;transition:all .2s;color:#1e3a5f;white-space:nowrap}
        .tb:hover{color:#334155}.tb.on{color:#38bdf8;border-bottom-color:#38bdf8}
        .panel{background:rgba(6,15,36,.82);border:1px solid #08193a;border-radius:10px;padding:14px}
        input[type=range]{-webkit-appearance:none;width:100%;height:4px;background:#0a1628;border-radius:2px;outline:none}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:13px;height:13px;background:#38bdf8;border-radius:50%;cursor:pointer}
      `}</style>

      {/* HEADER */}
      <div style={{ background:"rgba(2,8,20,.97)", borderBottom:"1px solid #06142e", padding:"0 16px", display:"flex", alignItems:"center", gap:12, position:"sticky", top:0, zIndex:100, backdropFilter:"blur(10px)", flexWrap:"wrap" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 0", borderRight:"1px solid #08193a", paddingRight:14, marginRight:2, flexShrink:0 }}>
          <div style={{ width:24, height:24, border:"1.5px solid #38bdf8", borderRadius:4, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, color:"#38bdf8" }}>⬡</div>
          <div>
            <div style={{ fontSize:12, fontWeight:700, color:"#cbd5e1", letterSpacing:".12em" }}>SUPERSCA DA</div>
            <div style={{ fontSize:8, color:"#0f2744", letterSpacing:".1em" }}>NORTH RIVER WRRF · MICROBIAL AI</div>
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:5, flexShrink:0 }}>
          <div style={{ width:6, height:6, borderRadius:"50%", background:paused?"#fbbf24":autoMode?"#a78bfa":"#4ade80", animation:paused?"none":"blink 2.5s ease-in-out infinite" }}/>
          <span style={{ fontSize:9, color:paused?"#fbbf24":autoMode?"#a78bfa":"#4ade80", letterSpacing:".07em" }}>
            {paused?"PAUSED":autoMode?"AI AUTO":"MANUAL"}
          </span>
        </div>
        <span style={{ fontSize:9, color:"#0f2744", letterSpacing:".06em", flexShrink:0 }}>pH {fmt(data.pH,2)} · VFA {fmt(data.vfa,0)}mg/L · F/M {fmt(data.FM,3)} · Stress {fmt(data.microbialStress*100,0)}%</span>
        <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:8, flexShrink:0 }}>
          <div style={{ background:`${sC}14`, border:`1px solid ${sC}35`, borderRadius:6, padding:"3px 9px", fontSize:9, fontWeight:700, color:sC, letterSpacing:".1em" }}>{stability}</div>
          {data.bicarbonateDose>0 && <div style={{ background:"#34d39918", border:"1px solid #34d39940", borderRadius:6, padding:"3px 9px", fontSize:9, color:"#34d399", fontWeight:700 }}>⚗ DOSING</div>}
          {data.dilutionActive && <div style={{ background:"#fbbf2418", border:"1px solid #fbbf2440", borderRadius:6, padding:"3px 9px", fontSize:9, color:"#fbbf24", fontWeight:700 }}>💧 DILUTION</div>}
          {critN>0 && <div style={{ background:"#f8717118", border:"1px solid #f8717140", borderRadius:6, padding:"3px 9px", fontSize:9, color:"#f87171", fontWeight:700, animation:"blink 1.2s ease-in-out infinite" }}>⚠ {critN} CRIT</div>}
          <button onClick={()=>setPaused(p=>!p)} style={{ background:paused?"#38bdf812":"#060f24", border:`1px solid ${paused?"#38bdf850":"#08193a"}`, color:paused?"#38bdf8":"#334155", borderRadius:6, padding:"3px 10px", cursor:"pointer", fontSize:9, fontFamily:"monospace" }}>{paused?"▶":"⏸"}</button>
        </div>
      </div>

      {/* TABS */}
      <div style={{ background:"rgba(2,8,20,.9)", borderBottom:"1px solid #06142e", padding:"0 16px", display:"flex", overflowX:"auto" }}>
        {TABS.map(t=>(
          <button key={t} className={`tb ${tab===t?"on":""}`} onClick={()=>setTab(t)}>
            {t==="ai-control"?"AI CONTROL":t.toUpperCase()}
          </button>
        ))}
        <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:5, flexShrink:0 }}>
          {["live","historical"].map(m=>(
            <button key={m} onClick={()=>setLiveMode(m==="live")} style={{ background:(m==="live")===liveMode?"#38bdf815":"none", border:`1px solid ${(m==="live")===liveMode?"#38bdf845":"#06142e"}`, color:(m==="live")===liveMode?"#38bdf8":"#1e3a5f", borderRadius:5, padding:"2px 7px", cursor:"pointer", fontSize:8, fontFamily:"monospace" }}>{m.toUpperCase()}</button>
          ))}
        </div>
      </div>

      <div style={{ padding:"12px 16px", maxWidth:1600, margin:"0 auto" }}>

        {/* ══════════════════════════════════════════════════════════════
            OVERVIEW
        ══════════════════════════════════════════════════════════════ */}
        {tab==="overview" && (<div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(145px,1fr))", gap:8, marginBottom:12 }}>
            <KPI label="Microbial Stress" value={fmt(data.microbialStress*100,1)} unit="%" color={sC} pulse={data.microbialStress>0.5} sub="0=healthy 100=failing"/>
            <KPI label="VFA Direct Meas." value={fmt(data.vfa,0)} unit="mg/L" color={paramColor(data.vfa,"vfa")} sub="Target <500 mg/L" pulse={data.vfa>600}/>
            <KPI label="F/M Ratio" value={fmt(data.FM,3)} unit="gCOD/gVSS·d" color={paramColor(data.FM,"FM")} sub="Target 0.1–0.5"/>
            <KPI label="pH" value={fmt(data.pH,2)} unit="" color={paramColor(data.pH,"pH")} sub="Target 6.8–7.2" pulse={data.pH<6.75||data.pH>7.35}/>
            <KPI label="Temperature" value={fmt(data.temperature,1)} unit="°C" color={paramColor(data.temperature,"temperature")} sub="Optimal 35–37°C"/>
            <KPI label="Inhibitor Index" value={fmt(data.inhibitorIndex*100,1)} unit="%" color={data.inhibitorIndex>0.45?"#f87171":data.inhibitorIndex>0.25?"#fbbf24":"#4ade80"} pulse={data.inhibitorIndex>0.45}/>
            <KPI label="C:N:P" value={data.cnpRatio} unit="" color={data.cnpStatus==="OPTIMAL"?"#4ade80":data.cnpStatus==="MARGINAL"?"#fbbf24":"#f87171"} sub={`Status: ${data.cnpStatus}`}/>
            <KPI label="SRT" value={fmt(data.SRT,1)} unit="days" color={paramColor(data.SRT,"SRT")} sub="Mesophilic: 15–35d"/>
            <KPI label="Biogas" value={fmt(data.biogasRate,0)} unit="m³/d" color="#facc15" sub={`${fmt(data.methane,1)}% CH₄`}/>
            <KPI label="NaHCO₃ Dose" value={fmt(data.bicarbonateDose,0)} unit="kg/d" color={data.bicarbonateDose>0?"#34d399":"#334155"} sub={data.autoMode?"Auto-managed":"Manual"} warn={false}/>
          </div>

          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 300px", gap:12, marginBottom:12 }}>
            <div className="panel">
              <Head icon="▶">Biogas + VFA Trend</Head>
              <ResponsiveContainer width="100%" height={190}>
                <LineChart data={history} margin={{top:4,right:8,left:-14,bottom:0}}>
                  <CartesianGrid strokeDasharray="1 5" stroke="#030812"/>
                  <XAxis dataKey="timestamp" tick={{fill:"#0f2040",fontSize:9}} interval="preserveStartEnd"/>
                  <YAxis yAxisId="g"  tick={{fill:"#0f2040",fontSize:9}} domain={[3000,13000]}/>
                  <YAxis yAxisId="v" orientation="right" tick={{fill:"#0f2040",fontSize:9}} domain={[0,2000]}/>
                  <Tooltip {...TT}/>
                  <ReferenceLine yAxisId="v" y={800} stroke="#f8717140" strokeDasharray="3 3" label={{value:"VFA alarm",fill:"#f87171",fontSize:8}}/>
                  <Line yAxisId="g" type="monotone" dataKey="biogasRate" stroke="#facc15" strokeWidth={2} dot={false} isAnimationActive={false} name="Biogas m³/d"/>
                  <Line yAxisId="v" type="monotone" dataKey="vfa"        stroke="#f87171" strokeWidth={1.5} dot={false} isAnimationActive={false} name="VFA mg/L"/>
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="panel">
              <Head icon="▶">pH · Alkalinity · Dosing Response</Head>
              <ResponsiveContainer width="100%" height={190}>
                <LineChart data={history} margin={{top:4,right:8,left:-14,bottom:0}}>
                  <CartesianGrid strokeDasharray="1 5" stroke="#030812"/>
                  <XAxis dataKey="timestamp" tick={{fill:"#0f2040",fontSize:9}} interval="preserveStartEnd"/>
                  <YAxis yAxisId="p" tick={{fill:"#0f2040",fontSize:9}} domain={[6.0,8.0]}/>
                  <YAxis yAxisId="a" orientation="right" tick={{fill:"#0f2040",fontSize:9}} domain={[1500,5000]}/>
                  <Tooltip {...TT}/>
                  <ReferenceLine yAxisId="p" y={6.8} stroke="#fbbf2450" strokeDasharray="2 3" label={{value:"pH lo",fill:"#fbbf24",fontSize:8}}/>
                  <ReferenceLine yAxisId="p" y={7.2} stroke="#fbbf2450" strokeDasharray="2 3" label={{value:"pH hi",fill:"#fbbf24",fontSize:8}}/>
                  <Line yAxisId="p" type="monotone" dataKey="pH"         stroke="#a78bfa" strokeWidth={2}   dot={false} isAnimationActive={false} name="pH"/>
                  <Line yAxisId="a" type="monotone" dataKey="alkalinity" stroke="#34d399" strokeWidth={1.5} dot={false} isAnimationActive={false} name="Alk mg/L"/>
                </LineChart>
              </ResponsiveContainer>
            </div>
            <MicrobialRadar data={data} />
          </div>

          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            <div className="panel">
              <Head icon="▶">Microbial Stress + Inhibitor Index</Head>
              <ResponsiveContainer width="100%" height={140}>
                <LineChart data={history} margin={{top:4,right:8,left:-14,bottom:0}}>
                  <CartesianGrid strokeDasharray="1 5" stroke="#030812"/>
                  <XAxis dataKey="timestamp" hide/><YAxis tick={{fill:"#0f2040",fontSize:9}} domain={[0,1]}/>
                  <Tooltip {...TT}/>
                  <ReferenceLine y={0.5} stroke="#f8717150" strokeDasharray="3 3" label={{value:"Stress alarm",fill:"#f87171",fontSize:8}}/>
                  <Line type="monotone" dataKey="microbialStress" stroke="#fb7185" strokeWidth={2} dot={false} isAnimationActive={false} name="Microbial Stress"/>
                  <Line type="monotone" dataKey="inhibitorIndex"  stroke="#fbbf24" strokeWidth={1.5} dot={false} isAnimationActive={false} name="Inhibitor Index"/>
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="panel">
              <Head icon="▶">SRT / HRT — Retention Time Envelope</Head>
              <ResponsiveContainer width="100%" height={140}>
                <LineChart data={history} margin={{top:4,right:8,left:-14,bottom:0}}>
                  <CartesianGrid strokeDasharray="1 5" stroke="#030812"/>
                  <XAxis dataKey="timestamp" hide/><YAxis tick={{fill:"#0f2040",fontSize:9}} domain={[0,50]}/>
                  <Tooltip {...TT}/>
                  <ReferenceLine y={15} stroke="#38bdf840" strokeDasharray="2 4" label={{value:"SRT min",fill:"#38bdf8",fontSize:8}}/>
                  <ReferenceLine y={35} stroke="#38bdf840" strokeDasharray="2 4" label={{value:"SRT max",fill:"#38bdf8",fontSize:8}}/>
                  <ReferenceLine y={20} stroke="#818cf840" strokeDasharray="2 4" label={{value:"HRT max",fill:"#818cf8",fontSize:8}}/>
                  <Line type="monotone" dataKey="SRT" stroke="#c4b5fd" strokeWidth={2}   dot={false} isAnimationActive={false} name="SRT days"/>
                  <Line type="monotone" dataKey="HRT" stroke="#818cf8" strokeWidth={1.5} dot={false} isAnimationActive={false} name="HRT days"/>
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
          {alarms.length>0 && (
            <div className="panel" style={{marginTop:12}}>
              <Head icon="⚠">Recent Alarms & AI Actions</Head>
              {alarms.slice(0,6).map((a,i)=><AlarmLine key={i} {...a}/>)}
            </div>
          )}
        </div>)}

        {/* ══════════════════════════════════════════════════════════════
            MICROBIAL HEALTH TAB
        ══════════════════════════════════════════════════════════════ */}
        {tab==="microbial" && (<div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:12 }}>
            <div className="panel">
              <Head icon="◈">Microbial Stress Indicators</Head>
              <GaugeBar label="pH"          value={data.pH}          lo={6.8}  hi={7.2}  unit=""          color="#a78bfa" decimals={2}/>
              <GaugeBar label="Temperature" value={data.temperature} lo={35.0} hi={37.0} unit="°C"        color="#fb923c" decimals={1}/>
              <GaugeBar label="VFA (direct)"value={data.vfa}         lo={0}    hi={500}  unit="mg/L HAc"  color="#f87171" decimals={0}/>
              <GaugeBar label="F/M Ratio"   value={data.FM}          lo={0.05} hi={0.50} unit="gCOD/gVSS·d" color="#e879f9" decimals={3}/>
              <GaugeBar label="VFA/Alk"     value={data.vfaAlkRatio} lo={0}    hi={0.30} unit=""          color="#fca5a5" decimals={3}/>
              <GaugeBar label="COD (digester)" value={data.cod}      lo={8000} hi={22000}unit="mg/L"      color="#f97316" decimals={0}/>
              <GaugeBar label="Active Biomass" value={data.biomass}  lo={15000}hi={50000}unit="mg VSS/L"  color="#86efac" decimals={0}/>
            </div>
            <div className="panel">
              <Head icon="◈">VFA, F/M & COD Trend</Head>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={history} margin={{top:4,right:8,left:-14,bottom:0}}>
                  <CartesianGrid strokeDasharray="1 5" stroke="#030812"/>
                  <XAxis dataKey="timestamp" tick={{fill:"#0f2040",fontSize:9}} interval="preserveStartEnd"/>
                  <YAxis yAxisId="v" tick={{fill:"#0f2040",fontSize:9}} domain={[0,2500]}/>
                  <YAxis yAxisId="f" orientation="right" tick={{fill:"#0f2040",fontSize:9}} domain={[0,1]}/>
                  <Tooltip {...TT}/>
                  <ReferenceLine yAxisId="v" y={500} stroke="#f8717140" strokeDasharray="3 3" label={{value:"VFA 500",fill:"#f87171",fontSize:8}}/>
                  <Line yAxisId="v" type="monotone" dataKey="vfa"         stroke="#f87171" strokeWidth={2}   dot={false} isAnimationActive={false} name="VFA mg/L"/>
                  <Line yAxisId="f" type="monotone" dataKey="FM"          stroke="#e879f9" strokeWidth={1.5} dot={false} isAnimationActive={false} name="F/M ratio"/>
                  <Line yAxisId="f" type="monotone" dataKey="vfaAlkRatio" stroke="#fca5a5" strokeWidth={1}   dot={false} isAnimationActive={false} name="VFA/Alk"/>
                </LineChart>
              </ResponsiveContainer>
              <div style={{ marginTop:12 }}>
                <Head icon="◈">pH Stability — Target 6.8–7.2</Head>
                <ResponsiveContainer width="100%" height={140}>
                  <AreaChart data={history} margin={{top:4,right:8,left:-14,bottom:0}}>
                    <defs>
                      <linearGradient id="phG" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.3}/><stop offset="100%" stopColor="#a78bfa" stopOpacity={0.02}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="1 5" stroke="#030812"/>
                    <XAxis dataKey="timestamp" hide/><YAxis tick={{fill:"#0f2040",fontSize:9}} domain={[6.2,8.0]}/>
                    <Tooltip {...TT}/>
                    <ReferenceLine y={6.8} stroke="#fbbf2450" strokeDasharray="2 3" label={{value:"6.8",fill:"#fbbf24",fontSize:8}}/>
                    <ReferenceLine y={7.2} stroke="#fbbf2450" strokeDasharray="2 3" label={{value:"7.2",fill:"#fbbf24",fontSize:8}}/>
                    <Area type="monotone" dataKey="pH" stroke="#a78bfa" strokeWidth={2} fill="url(#phG)" dot={false} isAnimationActive={false}/>
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12 }}>
            {[
              {k:"vfa",         lbl:"VFA Direct",   color:"#f87171", hi:800,  lo:0},
              {k:"FM",          lbl:"F/M Ratio",    color:"#e879f9", hi:0.8,  lo:0},
              {k:"microbialStress",lbl:"Stress Idx",color:"#fb7185", hi:1.0,  lo:0},
              {k:"biomass",     lbl:"Biomass VSS",  color:"#86efac", hi:55000,lo:8000},
              {k:"cod",         lbl:"Digester COD", color:"#f97316", hi:30000,lo:0},
              {k:"pH",          lbl:"pH",           color:"#a78bfa", hi:8.0,  lo:6.2},
            ].map(({k,lbl,color,lo,hi})=>(
              <div key={k} className="panel">
                <div style={{ fontSize:9, color:"#334155", marginBottom:4, fontFamily:"monospace" }}>{lbl}</div>
                <div style={{ fontSize:20, fontWeight:700, color, fontFamily:"monospace", marginBottom:6 }}>
                  {fmt(data[k], k==="pH"||k==="FM"||k==="microbialStress"?3:0)}
                </div>
                <Spark data={history} k={k} color={color} lo={lo>0?lo:undefined} hi={hi}/>
              </div>
            ))}
          </div>
        </div>)}

        {/* ══════════════════════════════════════════════════════════════
            INHIBITORS TAB
        ══════════════════════════════════════════════════════════════ */}
        {tab==="inhibitors" && (<div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 280px", gap:12, marginBottom:12 }}>
            <div className="panel">
              <Head icon="⚠">Inhibitor Monitoring — Pattern Detection</Head>
              <InhibitorPanel data={data} log={inhibLog}/>
            </div>
            <div className="panel">
              <Head icon="◈">Inhibitor Index Trend</Head>
              <Spark data={history} k="inhibitorIndex" color="#f87171" h={140} hi={0.45}/>
              <div style={{ marginTop:12 }}>
                <div style={{ fontSize:9, color:"#334155", marginBottom:8, letterSpacing:".08em" }}>MITIGATION ACTIONS (AI)</div>
                {[
                  { cond:data.nh3>200,      msg:`NH₃ ${fmt(data.nh3,0)} mg/L — free ammonia inhibition risk; pH reduction may lower free fraction`, sev:"WARNING" },
                  { cond:data.sulfide>35,   msg:`Sulfide ${fmt(data.sulfide,1)} mg/L — H₂S toxic threshold; aeration or iron dosing recommended`, sev:"WARNING" },
                  { cond:data.heavyMetals>0.3,msg:`Heavy metal index elevated — check industrial discharge; consider EDTA chelation`, sev:"WARNING" },
                  { cond:data.dilutionActive,msg:`Dilution active — reducing inhibitor concentrations by increasing water input`, sev:"INFO" },
                  { cond:data.inhibitorIndex<0.15,msg:"✓ Inhibitor levels within acceptable range — no mitigation required", sev:"OK" },
                ].filter(x=>x.cond).map((x,i)=>(
                  <div key={i} style={{ background:x.sev==="OK"?"#4ade8010":"#fbbf2410", border:`1px solid ${x.sev==="OK"?"#4ade8025":"#fbbf2425"}`, borderRadius:7, padding:"8px 10px", marginBottom:6, fontSize:10, color:x.sev==="OK"?"#4ade80":"#fbbf24", lineHeight:1.5 }}>{x.msg}</div>
                ))}
              </div>
              <div style={{ marginTop:12 }}>
                <div style={{ fontSize:9, color:"#334155", marginBottom:6, letterSpacing:".08em" }}>NH₃ & SULFIDE TREND</div>
                <Spark data={history} k="nh3"     color="#fca5a5" h={65} hi={200}/>
                <Spark data={history} k="sulfide" color="#fde68a" h={65} hi={35}/>
              </div>
            </div>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            <div className="panel">
              <Head icon="▶">NH₃ & Sulfide History</Head>
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={history} margin={{top:4,right:8,left:-14,bottom:0}}>
                  <CartesianGrid strokeDasharray="1 5" stroke="#030812"/>
                  <XAxis dataKey="timestamp" tick={{fill:"#0f2040",fontSize:9}} interval="preserveStartEnd"/>
                  <YAxis yAxisId="n" tick={{fill:"#0f2040",fontSize:9}} domain={[0,500]}/>
                  <YAxis yAxisId="s" orientation="right" tick={{fill:"#0f2040",fontSize:9}} domain={[0,100]}/>
                  <Tooltip {...TT}/>
                  <ReferenceLine yAxisId="n" y={200} stroke="#fca5a540" strokeDasharray="3 3" label={{value:"NH₃ alarm",fill:"#fca5a5",fontSize:8}}/>
                  <ReferenceLine yAxisId="s" y={35}  stroke="#fde68a40" strokeDasharray="3 3" label={{value:"H₂S alarm",fill:"#fde68a",fontSize:8}}/>
                  <Line yAxisId="n" type="monotone" dataKey="nh3"     stroke="#fca5a5" strokeWidth={2}   dot={false} isAnimationActive={false} name="NH₃ mg/L"/>
                  <Line yAxisId="s" type="monotone" dataKey="sulfide" stroke="#fde68a" strokeWidth={1.5} dot={false} isAnimationActive={false} name="Sulfide mg/L"/>
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="panel">
              <Head icon="▶">Overall Inhibitor Index + Feed Rate Response</Head>
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={history} margin={{top:4,right:8,left:-14,bottom:0}}>
                  <CartesianGrid strokeDasharray="1 5" stroke="#030812"/>
                  <XAxis dataKey="timestamp" tick={{fill:"#0f2040",fontSize:9}} interval="preserveStartEnd"/>
                  <YAxis yAxisId="i" tick={{fill:"#0f2040",fontSize:9}} domain={[0,1]}/>
                  <YAxis yAxisId="f" orientation="right" tick={{fill:"#0f2040",fontSize:9}} domain={[0,2]}/>
                  <Tooltip {...TT}/>
                  <ReferenceLine yAxisId="i" y={0.45} stroke="#f8717140" strokeDasharray="3 3" label={{value:"Inhibitor alarm",fill:"#f87171",fontSize:8}}/>
                  <Line yAxisId="i" type="monotone" dataKey="inhibitorIndex" stroke="#f87171" strokeWidth={2}   dot={false} isAnimationActive={false} name="Inhibitor Index"/>
                  <Line yAxisId="f" type="monotone" dataKey="feedRate"       stroke="#38bdf8" strokeWidth={1.5} dot={false} isAnimationActive={false} name="Feed Rate"/>
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>)}

        {/* ══════════════════════════════════════════════════════════════
            NUTRIENTS TAB (C:N:P)
        ══════════════════════════════════════════════════════════════ */}
        {tab==="nutrients" && (<div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:12 }}>
            <div className="panel">
              <Head icon="◈">C : N : P Ratio Analysis</Head>
              <CNPGauge data={data} />
              <div style={{ marginTop:14 }}>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
                  {[
                    { lbl:"Influent COD (C)", val:data.cod_inf, unit:"mg/L", color:"#f97316", sub:"Carbon proxy" },
                    { lbl:"Total Nitrogen",   val:data.tn,      unit:"mg/L", color:"#38bdf8", sub:"NH₄⁺ + NO₃⁻" },
                    { lbl:"Total Phosphorus", val:data.tp,      unit:"mg/L", color:"#818cf8", sub:"PO₄³⁻ eq." },
                  ].map(({lbl,val,unit,color,sub})=>(
                    <div key={lbl} style={{ background:"#030812", borderRadius:8, padding:"10px 12px" }}>
                      <div style={{ fontSize:9, color:"#334155", marginBottom:3, fontFamily:"monospace" }}>{lbl}</div>
                      <div style={{ fontSize:18, fontWeight:700, color, fontFamily:"monospace" }}>{fmt(val,0)} <span style={{ fontSize:9, color:"#475569" }}>{unit}</span></div>
                      <div style={{ fontSize:8, color:"#1e3a5f", marginTop:2 }}>{sub}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="panel">
              <Head icon="◈">AI Nutrient Recommendations</Head>
              {[
                { cond:data.C_N>25, msg:`C:N ratio ${data.C_N.toFixed(1)} — excess carbon. Supplement with nitrogen source (e.g. urea or struvite) to approach 20:1 target.`, sev:"INFO" },
                { cond:data.C_N<15, msg:`C:N ratio ${data.C_N.toFixed(1)} — excess nitrogen. Reduce high-N co-substrates or blend with low-N primary sludge.`, sev:"INFO" },
                { cond:data.N_P>7,  msg:`N:P ratio ${data.N_P.toFixed(1)} — nitrogen surplus relative to phosphorus. Consider phosphorus supplementation.`, sev:"INFO" },
                { cond:data.N_P<3,  msg:`N:P ratio ${data.N_P.toFixed(1)} — phosphorus excess. Assess for struvite precipitation risk in downstream handling.`, sev:"INFO" },
                { cond:data.C_N>=15&&data.C_N<=25&&data.N_P>=3&&data.N_P<=7,
                  msg:"✓ C:N:P nutrient ratios within optimal range. Microbial growth conditions are well-supported.", sev:"OK" },
              ].filter(x=>x.cond).map((x,i)=>(
                <div key={i} style={{ background:x.sev==="OK"?"#4ade8010":"#38bdf810", border:`1px solid ${x.sev==="OK"?"#4ade8025":"#38bdf825"}`, borderRadius:7, padding:"8px 10px", marginBottom:8, fontSize:11, color:x.sev==="OK"?"#4ade80":"#38bdf8", lineHeight:1.6 }}>{x.msg}</div>
              ))}
              <div style={{ marginTop:12 }}>
                <div style={{ fontSize:9, color:"#334155", letterSpacing:".08em", marginBottom:8 }}>C:N:P TREND — RATIO HISTORY</div>
                <div style={{ fontSize:9, color:"#1e3a5f", marginBottom:4 }}>C:N Ratio (target 15–25)</div>
                <Spark data={history} k="C_N" color="#38bdf8" h={70} lo={15} hi={25}/>
                <div style={{ fontSize:9, color:"#1e3a5f", marginTop:8, marginBottom:4 }}>N:P Ratio (target 3–7)</div>
                <Spark data={history} k="N_P" color="#818cf8" h={70} lo={3} hi={7}/>
              </div>
            </div>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12 }}>
            {[
              {k:"cod_inf",lbl:"Influent COD",color:"#f97316"},
              {k:"tn",     lbl:"Total Nitrogen",color:"#38bdf8"},
              {k:"tp",     lbl:"Total Phosphorus",color:"#818cf8"},
            ].map(({k,lbl,color})=>(
              <div key={k} className="panel">
                <div style={{ fontSize:9, color:"#334155", marginBottom:4 }}>{lbl} — Influent</div>
                <div style={{ fontSize:20, fontWeight:700, color, fontFamily:"monospace", marginBottom:6 }}>{fmt(data[k],0)} <span style={{ fontSize:9, color:"#475569" }}>mg/L</span></div>
                <Spark data={history} k={k} color={color} h={80}/>
              </div>
            ))}
          </div>
        </div>)}

        {/* ══════════════════════════════════════════════════════════════
            RETENTION TIME TAB
        ══════════════════════════════════════════════════════════════ */}
        {tab==="retention" && (<div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(145px,1fr))", gap:8, marginBottom:12 }}>
            <KPI label="SRT" value={fmt(data.SRT,1)} unit="days" color={paramColor(data.SRT,"SRT")} sub="Target 15–35d (mesophilic)" pulse={data.SRT<15||data.SRT>38}/>
            <KPI label="HRT (Primary)" value={fmt(data.HRT,1)} unit="days" color={paramColor(data.HRT,"HRT")} sub="Target 15–20d"/>
            <KPI label="Active Biomass" value={fmt(data.biomass,0)} unit="mg VSS/L" color="#86efac" sub="Methanogen population"/>
            <KPI label="Feed Rate" value={fmt(data.feedRate*100,0)} unit="%" color={data.feedRate>1.3?"#f87171":data.feedRate<0.7?"#fbbf24":"#4ade80"} sub={data.autoMode?"AI-managed":"Manual"}/>
            <KPI label="Wasting Rate" value={fmt(data.wastingRate*100,0)} unit="%" color="#818cf8" sub={data.autoMode?"AI-managed":"Manual"}/>
            <KPI label="OLR" value={fmt(data.OLR,4)} unit="kgVS/m³·d" color="#fbbf24" sub="Primary stage (22,652 m³)"/>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:12 }}>
            <div className="panel">
              <Head icon="▶">SRT & HRT — Mesophilic Retention Envelope</Head>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={history} margin={{top:4,right:8,left:-14,bottom:0}}>
                  <CartesianGrid strokeDasharray="1 5" stroke="#030812"/>
                  <XAxis dataKey="timestamp" tick={{fill:"#0f2040",fontSize:9}} interval="preserveStartEnd"/>
                  <YAxis tick={{fill:"#0f2040",fontSize:9}} domain={[0,55]}/>
                  <Tooltip {...TT}/>
                  <ReferenceLine y={15} stroke="#38bdf840" strokeDasharray="2 4" label={{value:"SRT/HRT min 15d",fill:"#38bdf8",fontSize:8}}/>
                  <ReferenceLine y={20} stroke="#818cf840" strokeDasharray="2 4" label={{value:"HRT max 20d",fill:"#818cf8",fontSize:8}}/>
                  <ReferenceLine y={35} stroke="#c4b5fd40" strokeDasharray="2 4" label={{value:"SRT max 35d",fill:"#c4b5fd",fontSize:8}}/>
                  <Line type="monotone" dataKey="SRT" stroke="#c4b5fd" strokeWidth={2}   dot={false} isAnimationActive={false} name="SRT days"/>
                  <Line type="monotone" dataKey="HRT" stroke="#818cf8" strokeWidth={1.5} dot={false} isAnimationActive={false} name="HRT days"/>
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="panel">
              <Head icon="▶">Feed Rate · Wasting Rate — Dynamic Adjustment</Head>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={history} margin={{top:4,right:8,left:-14,bottom:0}}>
                  <CartesianGrid strokeDasharray="1 5" stroke="#030812"/>
                  <XAxis dataKey="timestamp" tick={{fill:"#0f2040",fontSize:9}} interval="preserveStartEnd"/>
                  <YAxis tick={{fill:"#0f2040",fontSize:9}} domain={[0,2]}/>
                  <Tooltip {...TT}/>
                  <ReferenceLine y={1.0} stroke="#38bdf820" strokeDasharray="2 4" label={{value:"Nominal",fill:"#38bdf8",fontSize:8}}/>
                  <Line type="monotone" dataKey="feedRate"    stroke="#38bdf8" strokeWidth={2}   dot={false} isAnimationActive={false} name="Feed Rate"/>
                  <Line type="monotone" dataKey="wastingRate" stroke="#818cf8" strokeWidth={1.5} dot={false} isAnimationActive={false} name="Wasting Rate"/>
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            <div className="panel">
              <Head icon="▶">Biomass Population + Biogas Yield</Head>
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={history} margin={{top:4,right:8,left:-14,bottom:0}}>
                  <CartesianGrid strokeDasharray="1 5" stroke="#030812"/>
                  <XAxis dataKey="timestamp" hide/>
                  <YAxis yAxisId="b" tick={{fill:"#0f2040",fontSize:9}} domain={[8000,55000]}/>
                  <YAxis yAxisId="g" orientation="right" tick={{fill:"#0f2040",fontSize:9}} domain={[3000,13000]}/>
                  <Tooltip {...TT}/>
                  <Line yAxisId="b" type="monotone" dataKey="biomass"    stroke="#86efac" strokeWidth={2}   dot={false} isAnimationActive={false} name="Biomass VSS"/>
                  <Line yAxisId="g" type="monotone" dataKey="biogasRate" stroke="#facc15" strokeWidth={1.5} dot={false} isAnimationActive={false} name="Biogas m³/d"/>
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="panel">
              <Head icon="◈">SRT Optimization Logic</Head>
              <div style={{ fontSize:10, color:"#475569", lineHeight:1.8, fontFamily:"monospace" }}>
                <div style={{ marginBottom:8, color:"#334155" }}>Current SRT: <span style={{ color:paramColor(data.SRT,"SRT"), fontWeight:700 }}>{fmt(data.SRT,1)} days</span></div>
                {[
                  ["Optimal range", "15–35 days (mesophilic)"],
                  ["If SRT < 15d",  "Washout risk — reduce wasting immediately"],
                  ["If SRT > 35d",  "Excess retention — increase wasting rate"],
                  ["Current action",data.SRT<15?"⚠ REDUCE WASTING":data.SRT>35?"↑ INCREASE WASTING":"✓ WITHIN ENVELOPE"],
                  ["OLR loading",   `${fmt(data.OLR,4)} kgVS/m³·d`],
                  ["VS loading",    `${fmt(data.vsLoading,0)} kg/d`],
                  ["VS destroyed",  `${fmt(data.vsDestroyed,0)} kg/d`],
                  ["Methane yield", `${fmt(data.methaneYield,4)} m³CH₄/kgVS`],
                ].map(([k,v])=>(
                  <div key={k} style={{ display:"flex", justifyContent:"space-between", borderBottom:"1px solid #06142e", paddingBottom:4, marginBottom:4 }}>
                    <span style={{ color:"#334155" }}>{k}</span>
                    <span style={{ color: v.includes("⚠")?"#f87171":v.includes("✓")?"#4ade80":"#64748b", fontWeight:600 }}>{v}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>)}

        {/* ══════════════════════════════════════════════════════════════
            AI CONTROL TAB
        ══════════════════════════════════════════════════════════════ */}
        {tab==="ai-control" && (<div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:12 }}>
            <div className="panel">
              <Head icon="◈">AI Autonomous Control Panel</Head>
              <AutoControlPanel
                data={data} feedRate={feedRate} wastingRate={wastRate} autoMode={autoMode}
                onFeedChange={v=>{ setFeedRate(v); engine.setFeedRate(v); }}
                onWasteChange={v=>{ setWastRate(v); engine.setWastingRate(v); }}
                onAutoToggle={()=>setAutoMode(m=>!m)}
              />
            </div>
            <div className="panel">
              <Head icon="◈">Predictive Intelligence</Head>
              {pred ? (<>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:12 }}>
                  {[
                    {lbl:"Next Biogas",    val:`${pred.biogasNext} m³/d`, risk:pred.biogasRisk},
                    {lbl:"Next pH",        val:pred.phNext,               risk:pred.stabilityRisk},
                    {lbl:"VFA/Alk Next",   val:pred.vfaAlkNext,           risk:pred.vfaRisk},
                    {lbl:"F/M Next",       val:pred.fmNext,               risk:pred.fmRisk},
                    {lbl:"Inhibitor Next", val:pred.inhibNext,            risk:pred.inhibRisk},
                    {lbl:"Stress Next",    val:pred.stressNext,           risk:pred.stressRisk},
                    {lbl:"SRT Next",       val:`${pred.srtNext}d`,        risk:pred.srtRisk},
                  ].map(({lbl,val,risk})=>(
                    <div key={lbl} style={{ background:"#030812", borderRadius:7, padding:"8px 10px", border:`1px solid ${rc(risk)}20` }}>
                      <div style={{ fontSize:9, color:"#1e3a5f", marginBottom:2 }}>{lbl}</div>
                      <div style={{ fontSize:15, fontWeight:700, color:rc(risk), fontFamily:"monospace" }}>{val}</div>
                      <div style={{ fontSize:8, background:`${rc(risk)}15`, color:rc(risk), borderRadius:4, padding:"1px 5px", display:"inline-block", marginTop:2, fontWeight:700 }}>{risk}</div>
                    </div>
                  ))}
                </div>
                <div style={{ background:"#030812", borderRadius:8, padding:"9px 11px" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:5, fontSize:9, color:"#1e3a5f" }}>
                    <span>MODEL CONFIDENCE</span>
                    <span style={{ color:pred.confidence>80?"#4ade80":"#fbbf24" }}>{fmt(pred.confidence,0)}%</span>
                  </div>
                  <div style={{ background:"#06142e", borderRadius:3, height:5 }}>
                    <div style={{ width:`${pred.confidence}%`, height:"100%", borderRadius:3, background:pred.confidence>80?"#4ade80":"#fbbf24", transition:"width .5s ease" }}/>
                  </div>
                </div>
              </>) : <div style={{ color:"#1e3a5f", fontSize:11 }}>Collecting samples... {history.length}/5</div>}
            </div>
          </div>

          {/* AI action log */}
          <div className="panel" style={{ marginBottom:12 }}>
            <Head icon="◈">AI Action Log — Autonomous Interventions</Head>
            <div style={{ maxHeight:260, overflowY:"auto" }}>
              {alarms.filter(a=>a.cat==="AI").length===0 ? (
                <div style={{ color:"#334155", fontSize:11, padding:"16px 0", textAlign:"center" }}>No AI interventions logged yet</div>
              ) : alarms.filter(a=>a.cat==="AI").slice(0,20).map((a,i)=>(
                <AlarmLine key={i} {...a}/>
              ))}
            </div>
          </div>

          {/* Prediction recommendations */}
          <div className="panel">
            <Head icon="◈">Predictive Recommendations</Head>
            {pred?.actions.map((a,i)=>(
              <div key={i} style={{
                background:a.sev==="LOW"?"#4ade8010":a.sev==="HIGH"?"#f8717110":"#fbbf2410",
                border:`1px solid ${a.sev==="LOW"?"#4ade8022":a.sev==="HIGH"?"#f8717122":"#fbbf2422"}`,
                borderRadius:8, padding:"9px 12px", marginBottom:7,
                fontSize:11, color:a.sev==="LOW"?"#4ade80":a.sev==="HIGH"?"#f87171":"#fbbf24", lineHeight:1.6,
                display:"flex", gap:10, alignItems:"flex-start",
              }}>
                <span style={{ background:`${a.sev==="LOW"?"#4ade80":a.sev==="HIGH"?"#f87171":"#fbbf24"}25`, color:a.sev==="LOW"?"#4ade80":a.sev==="HIGH"?"#f87171":"#fbbf24", borderRadius:5, padding:"2px 7px", fontSize:9, fontWeight:700, whiteSpace:"nowrap" }}>{a.cat}</span>
                <span>{a.msg}</span>
              </div>
            ))}
          </div>
        </div>)}

        {/* ══════════════════════════════════════════════════════════════
            HISTORIAN TAB
        ══════════════════════════════════════════════════════════════ */}
        {tab==="historian" && (<div>
          <div className="panel" style={{marginBottom:12}}>
            <Head icon="◈">Full Process Historian — Solids, Gas, Stability</Head>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={history} margin={{top:4,right:14,left:-10,bottom:0}}>
                <CartesianGrid strokeDasharray="1 5" stroke="#030812"/>
                <XAxis dataKey="timestamp" tick={{fill:"#0f2040",fontSize:9}} interval={Math.floor(history.length/8)}/>
                <YAxis yAxisId="g" tick={{fill:"#0f2040",fontSize:9}} domain={[3000,13000]}/>
                <YAxis yAxisId="v" orientation="right" tick={{fill:"#0f2040",fontSize:9}}/>
                <Tooltip {...TT}/>
                <ReferenceLine yAxisId="g" y={8400} stroke="#38bdf818" strokeDasharray="2 4"/>
                <Line yAxisId="g" type="monotone" dataKey="biogasRate"     stroke="#facc15" strokeWidth={2}   dot={false} isAnimationActive={false} name="Biogas m³/d"/>
                <Line yAxisId="v" type="monotone" dataKey="vsLoading"      stroke="#f472b6" strokeWidth={1.5} dot={false} isAnimationActive={false} name="VS Load kg/d"/>
                <Line yAxisId="v" type="monotone" dataKey="vsDestroyed"    stroke="#86efac" strokeWidth={1}   dot={false} isAnimationActive={false} name="VS Dest kg/d"/>
                <Line yAxisId="g" type="monotone" dataKey="ch4Volume"      stroke="#60a5fa" strokeWidth={1}   dot={false} isAnimationActive={false} name="CH₄ m³/d"/>
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="panel" style={{marginBottom:12}}>
            <Head icon="◈">Microbial Health Historian</Head>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={history} margin={{top:4,right:14,left:-10,bottom:0}}>
                <CartesianGrid strokeDasharray="1 5" stroke="#030812"/>
                <XAxis dataKey="timestamp" tick={{fill:"#0f2040",fontSize:9}} interval={Math.floor(history.length/8)}/>
                <YAxis yAxisId="p" tick={{fill:"#0f2040",fontSize:9}} domain={[6.0,8.0]}/>
                <YAxis yAxisId="s" orientation="right" tick={{fill:"#0f2040",fontSize:9}} domain={[0,1]}/>
                <Tooltip {...TT}/>
                <ReferenceLine yAxisId="p" y={6.8} stroke="#fbbf2450" strokeDasharray="3 3"/>
                <ReferenceLine yAxisId="p" y={7.2} stroke="#fbbf2450" strokeDasharray="3 3"/>
                <Line yAxisId="p" type="monotone" dataKey="pH"               stroke="#a78bfa" strokeWidth={2}   dot={false} isAnimationActive={false} name="pH"/>
                <Line yAxisId="p" type="monotone" dataKey="temperature"      stroke="#fb923c" strokeWidth={1.5} dot={false} isAnimationActive={false} name="Temp °C"/>
                <Line yAxisId="s" type="monotone" dataKey="microbialStress"  stroke="#fb7185" strokeWidth={1.5} dot={false} isAnimationActive={false} name="Stress Idx"/>
                <Line yAxisId="s" type="monotone" dataKey="inhibitorIndex"   stroke="#fbbf24" strokeWidth={1}   dot={false} isAnimationActive={false} name="Inhibitor Idx"/>
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="panel">
            <Head icon="◈">Tag Historian Table</Head>
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:9,fontFamily:"monospace"}}>
                <thead><tr style={{borderBottom:"1px solid #06142e"}}>
                  {["Time","Biogas","CH₄%","pH","Alk","VFA","F/M","NH₃","H₂S","Stress","SRT","HRT","C:N","Feed%"].map(h=>(
                    <th key={h} style={{textAlign:"right",padding:"4px 6px",color:"#1e3a5f",fontWeight:600,whiteSpace:"nowrap"}}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {history.slice(-15).reverse().map((r,i)=>(
                    <tr key={i} style={{borderBottom:"1px solid #030812"}}>
                      {[r.timestamp,fmt(r.biogasRate,0),fmt(r.methane,1),fmt(r.pH,2),fmt(r.alkalinity,0),
                        fmt(r.vfa,0),fmt(r.FM,3),fmt(r.nh3,0),fmt(r.sulfide,1),
                        fmt(r.microbialStress,3),fmt(r.SRT,1),fmt(r.HRT,1),fmt(r.C_N,1),
                        fmt(r.feedRate*100,0)+"%"
                      ].map((v,j)=>(
                        <td key={j} style={{textAlign:"right",padding:"3px 6px",color:i===0?"#64748b":"#1e3a5f"}}>{v}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>)}

        {/* Footer */}
        <div style={{ marginTop:14, borderTop:"1px solid #030812", paddingTop:8, display:"flex", justifyContent:"space-between", flexWrap:"wrap", gap:4, fontSize:8, color:"#06142e", fontFamily:"monospace" }}>
          <span>NORTH RIVER WRRF · 137TH ST & HUDSON RIVER · MANHATTAN · NYCDEP</span>
          <span>8 × 200k FT³ · HRT {fmt(data.HRT,1)}d · SRT {fmt(data.SRT,1)}d · {autoMode?"AI AUTO":"MANUAL"}</span>
          <span>pH {fmt(data.pH,2)} · VFA {fmt(data.vfa,0)} · F/M {fmt(data.FM,3)} · {paused?"PAUSED":"LIVE 2s"}</span>
        </div>
      </div>
    </div>
  );
}
