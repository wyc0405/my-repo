// ============================================================
// 200슨피단 전략 시그널 Worker  (Cloudflare Workers + 정적 파일)
//   GET /api/signal  → 전략 시그널 JSON
//   그 외 경로         → public/ 폴더의 정적 파일 (index.html)
//   예약 실행(cron)    → 텔레그램 알림 (매매 신호가 있을 때만)
//       · 사전 알림: 한국시간 21:30 (평일) — 오늘 밤 미국장에서 신호가 날 수 있으면 알림
//       · 확정 알림: 미국 장 마감 20분 뒤 (16:20 ET) — 종가로 신호가 확정되면 알림
//     필요한 비밀값 (Cloudflare 대시보드 → Worker → Settings → Variables and Secrets 에서 Secret 으로 추가)
//       TELEGRAM_BOT_TOKEN : BotFather 에서 받은 봇 토큰
//       TELEGRAM_CHAT_ID   : 알림 받을 내 채팅 ID
//
// 파이썬 백테스트(Strategy_1_TQQQ_SPX_200.py)의 매매 로직을 그대로 옮겨서
// 야후 파이낸스의 SPX(^GSPC) / TQQQ 일봉으로 전략을 처음부터 재현(시뮬레이션)하고,
// "오늘 시점의 포지션 · 분할매수 단계 · 익절/TS 기준 · 오늘의 신호"를 JSON으로 돌려줍니다.
//
// ※ 전략 파라미터는 아래 PARAMS 에서만 바꾸면 됩니다.
// ============================================================

const VERSION = "v1.3";

// ------------------------------------------------------------
// 텔레그램 알림 설정
// ------------------------------------------------------------
const ALERT = {
  PRE_ALERT: true,          // 사전 알림 사용 여부 (false 면 확정 알림만)
  PRE_ALERT_PCT: 1.5,       // SPX가 이 % 안쪽으로만 움직여도 신호가 나는 날 사전 알림
  PAGE_URL: "https://my-repo.wyc1566.workers.dev"   // 알림에 넣을 내 웹페이지 주소
};
const TRADE_TYPES = ["BUY", "TS", "TP", "REBAL", "EXIT"];

// 이동평균 기간에 따라 바뀌는 이름 (예: 200 → "200일선", "200슨피단")
const smaLabel = (P = PARAMS) => `${P.BAND_ROLLING_N}일선`;
const strategyName = (P = PARAMS) => `${P.BAND_ROLLING_N}슨피단`;

const PARAMS = {
  UP_BAND: 0.045,            // 상단 밴드 (이동평균선 +2.5%)
  DN_BAND: 0.04,             // 하단 밴드 (이동평균선 -3%)
  TS_THRESH: 0.05,           // SPX가 사이클 고점 대비 -10% → TS 발동 (발동 후 고점 리셋 = 연쇄)
  TS_THRESH_SELL: 0.3,       // TS 발동 시 TQQQ 보유량의 50% → SPYM
  RB_RATE_T: 9 / 10,         // 리밸런싱 TQQQ 비중
  RB_RATE_S: 1 / 10,         // 리밸런싱 SPYM 비중
  FEE: 0.0007,               // 매매 수수료 0.07%
  TAX_RATE: 0.22,            // 양도소득세 22%
  DEDUCTION: 2500.0,         // 연간 기본공제 ($)
  START_CAPITAL: 10000.0,    // 시뮬레이션 시작 자산 ($)
  TP_SELL_SMALL: 0.1,        // 소익절: TQQQ 10% → SPYM
  TP_SELL_BIG: 0.9,          // 대익절: TQQQ 50% → SPYM
  SPLIT_BUY_RATE_T: 4 / 5,   // 분할매수 시 TQQQ 비중
  SPLIT_BUY_RATE_S: 1 / 5,   // 분할매수 시 SPYM 비중
  STAGE_NUM: 5,              // 분할매수 횟수
  TP_THRESH_HOLDS: [0.10, 0.25, 0.50], // 소익절 기준 (사이클 수익률)
  BAND_ROLLING_N: 210,       // 이동평균 기간 (일) — 바꾸면 웹페이지·텔레그램 알림의 "N일선"·"N슨피단" 표시도 함께 바뀜
  CASH_APR: 0.035            // SGOV(현금) 연 이자율 가정 (파이썬은 DFF 실데이터 사용)
};

const RANGE = "5y";          // 시뮬레이션에 쓰는 과거 데이터 기간
const CACHE_SECONDS = 60;    // 야후 호출 보호용 캐시

const YAHOO_HOSTS = ["query2.finance.yahoo.com", "query1.finance.yahoo.com"];
const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json",
  "Accept-Language": "en-US,en;q=0.9"
};

// 미국 동부 기준 날짜(YYYY-MM-DD).
// 일봉 시각은 항상 09:30 ET 부근이라 고정 오프셋(-5h)만으로도 날짜가 바뀌지 않는다.
// Date/Intl 객체를 수천 번 만들지 않고 정수 계산만 써서 무료 플랜 CPU 제한(10ms)을 피한다.
function etDate(sec) {
  const z = Math.floor((sec - 18000) / 86400) + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return y + "-" + (m < 10 ? "0" : "") + m + "-" + (d < 10 ? "0" : "") + d;
}

// ------------------------------------------------------------
// 1) 데이터 수집
// ------------------------------------------------------------
async function fetchYahoo(symbol, range = RANGE) {
  let lastErr;
  for (const host of YAHOO_HOSTS) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
      const res = await fetch(url, { headers: FETCH_HEADERS });
      if (!res.ok) throw new Error(`${symbol} 데이터 요청 실패 (HTTP ${res.status})`);
      const json = await res.json();
      const r = json.chart.result[0];
      const meta = r.meta;
      const rawTs = r.timestamp || [];
      const rawClose = r.indicators.quote[0].close || [];

      const dates = [];
      const closes = [];
      rawTs.forEach((t, i) => {
        const v = rawClose[i];
        if (v === null || v === undefined || !(v > 0)) return;
        const d = etDate(t);
        if (dates.length && dates[dates.length - 1] === d) closes[closes.length - 1] = v;
        else { dates.push(d); closes.push(v); }
      });

      // 마지막 봉을 현재가(장중이면 실시간, 마감 후면 종가)로 교체/추가
      const liveDate = etDate(meta.regularMarketTime);
      const lastDate = dates[dates.length - 1];
      if (lastDate === liveDate) closes[closes.length - 1] = meta.regularMarketPrice;
      else if (liveDate > lastDate) { dates.push(liveDate); closes.push(meta.regularMarketPrice); }

      const reg = meta.currentTradingPeriod && meta.currentTradingPeriod.regular;
      const nowSec = Date.now() / 1000;
      const isOpen = !!reg && nowSec >= reg.start && nowSec < reg.end && (nowSec - meta.regularMarketTime) < 30 * 60;

      return { dates, closes, time: meta.regularMarketTime, isOpen,
               sessionStart: reg ? reg.start : null, sessionEnd: reg ? reg.end : null };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// ------------------------------------------------------------
// 2) 전략 시뮬레이션 (파이썬 back_test 로직 이식)
// ------------------------------------------------------------
function getSMA(data, p) {
  const ma = new Array(data.length).fill(null);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
    if (i >= p) sum -= data[i - p];
    if (i >= p - 1) ma[i] = sum / p;
  }
  return ma;
}

function simulate(dates, spx, tqqq, P) {
  const N = dates.length;
  const sma = getSMA(spx, P.BAND_ROLLING_N);
  const start = sma.findIndex((v) => v !== null);
  if (start < 0) throw new Error(`데이터가 부족합니다 (${smaLabel(P)} 계산 불가)`);

  const years = dates.map((d) => +d.slice(0, 4));
  const months = dates.map((d) => +d.slice(5, 7));
  const dayMs = dates.map((d) => Date.parse(d));
  const FEE = P.FEE;

  let cash = P.START_CAPITAL;
  let sharesT = 0, sharesS = 0, costT = 0, costS = 0;
  let position = "BELOW";
  let buyStage = 0;
  let localPeak = 0;
  let tpFlags = P.TP_THRESH_HOLDS.map(() => false);
  let bigTpStage = 0;
  let cycleStartEq = 0;
  let rebalanced = false;
  let realizedYear = 0;
  let taxesOwed = [];          // [year, amount]
  let totalTrades = 0, totalTs = 0;
  let peakEq = P.START_CAPITAL;

  const eq = [];
  const events = [];           // { date, acts:[{type,text,...}] }
  const cycles = [];           // 종료된 사이클 수익률
  let todayActs = [];
  let todayPos = "BELOW";
  let lastEq = P.START_CAPITAL;

  for (let i = start; i < N; i++) {
    const gap = i === 0 ? 1 : (dayMs[i] - dayMs[i - 1]) / 86400000;
    cash *= Math.pow(1 + P.CASH_APR / 365, gap);

    const cT = tqqq[i], cS = spx[i], cSig = spx[i];  // SPYM 대용 = SPX (파이썬과 동일)
    const smaNow = sma[i];
    const bUp = smaNow * (1 + P.UP_BAND);
    const bDown = smaNow * (1 - P.DN_BAND);
    const acts = [];

    todayPos = position;
    if (cSig >= bUp) todayPos = "ABOVE";
    else if (cSig < bDown) todayPos = "BELOW";

    // TQQQ 일부를 팔아 SPYM으로 옮기는 공통 동작 (TS / 리밸런싱 / 익절)
    const moveTtoS = (qty) => {
      const avg = costT / sharesT;
      const proceeds = qty * cT * (1 - FEE);
      const cgs = avg * qty;
      realizedYear += proceeds - cgs;
      sharesT -= qty; costT -= cgs;
      sharesS += proceeds * (1 - FEE) / cS; costS += proceeds;
    };

    if (position === "BELOW" && todayPos === "ABOVE") {
      // 상향 돌파 (진입)
      buyStage = 1;
      localPeak = cSig;
      tpFlags = P.TP_THRESH_HOLDS.map(() => false);
      rebalanced = false;
      bigTpStage = 0;
      cycleStartEq = cash + sharesT * cT + sharesS * cS;
      acts.push({ type: "ENTRY", text: "상단 밴드 돌파 (진입 시작)" });
    } else if (position === "ABOVE" && todayPos === "BELOW") {
      // 하향 이탈 (전량 청산)
      if (sharesT > 0 || sharesS > 0) {
        const avgT = sharesT > 0 ? costT / sharesT : 0;
        const avgS = sharesS > 0 ? costS / sharesS : 0;
        const valT = sharesT * cT * (1 - FEE);
        const valS = sharesS * cS * (1 - FEE);
        realizedYear += valT - avgT * sharesT;
        if (sharesS > 0) realizedYear += valS - avgS * sharesS;
        cash += valT + valS;
        sharesT = 0; sharesS = 0; costT = 0; costS = 0;
        totalTrades++;
        acts.push({ type: "EXIT", text: "하단 밴드 이탈 (TQQQ·SPYM 전량 청산 → SGOV)" });
      }
      if (cycleStartEq > 0) {
        const ret = cash / cycleStartEq - 1;
        cycles.push(ret);
        acts.push({ type: "CYCLE", text: `사이클 종료 ${ret >= 0 ? "익절" : "손절"} (${(ret * 100).toFixed(1)}%)` });
      }
      buyStage = 0;
      cycleStartEq = 0;
    }

    if (todayPos === "ABOVE") {
      if (cSig > localPeak) localPeak = cSig;

      if (buyStage > 0 && buyStage <= P.STAGE_NUM) {
        // 분할매수 (매 회 남은 현금을 남은 횟수로 나눔 → 사실상 균등 분할)
        const buyAmt = buyStage < P.STAGE_NUM ? cash / (P.STAGE_NUM + 1 - buyStage) : cash;
        if (buyAmt > 0) {
          const amtT = buyAmt * P.SPLIT_BUY_RATE_T * (1 - FEE);
          const amtS = buyAmt * P.SPLIT_BUY_RATE_S * (1 - FEE);
          sharesT += amtT / cT;
          sharesS += amtS / cS;
          costT += amtT;
          costS += amtS;
          cash -= buyAmt;
          acts.push({ type: "BUY", stage: buyStage, text: `${buyStage}/${P.STAGE_NUM}차 분할매수` });
        }
        buyStage++;
      } else if (cSig <= localPeak * (1 - P.TS_THRESH)) {
        // 연쇄 TS
        localPeak = cSig;
        const qty = sharesT * P.TS_THRESH_SELL;
        if (qty > 0) {
          moveTtoS(qty);
          totalTs++;
          acts.push({ type: "TS", frac: P.TS_THRESH_SELL, text: `TS 발동 (SPX 고점 대비 -${(P.TS_THRESH * 100).toFixed(0)}%) · TQQQ ${(P.TS_THRESH_SELL * 100).toFixed(0)}% → SPYM` });
        }
      } else if (i > start && cSig < bUp && spx[i - 1] >= sma[i - 1] * (1 + P.UP_BAND) && !rebalanced) {
        // 상승장에서 밴드 안으로 처음 재진입 → 1회 리밸런싱
        const totalEqNow = cash + sharesT * cT + sharesS * cS;
        const qty = (sharesT * cT - totalEqNow * P.RB_RATE_T) / cT;
        if (qty > 0) {
          moveTtoS(qty);
        } else if (sharesS > 0) {
          const sty = (sharesS * cS - totalEqNow * P.RB_RATE_S) / cS;
          const avg = costS / sharesS;
          const proceeds = sty * cS * (1 - FEE);
          const cgs = avg * sty;
          realizedYear += proceeds - cgs;
          sharesS -= sty; costS -= cgs;
          sharesT += proceeds * (1 - FEE) / cT; costT += proceeds;
        }
        rebalanced = true;
        acts.push({ type: "REBAL", text: `리밸런싱 (TQQQ ${(P.RB_RATE_T * 100).toFixed(0)}% / SPYM ${(P.RB_RATE_S * 100).toFixed(0)}%)` });
      }

      // 소익절 / 대익절
      const totalEqNow = cash + sharesT * cT + sharesS * cS;
      if (cycleStartEq > 0 && sharesT > 0) {
        const cycleRet = totalEqNow / cycleStartEq - 1;

        P.TP_THRESH_HOLDS.forEach((th, k) => {
          if (cycleRet >= th && !tpFlags[k]) {
            const qty = sharesT * P.TP_SELL_SMALL;
            if (qty > 0) {
              moveTtoS(qty);
              tpFlags[k] = true;
              acts.push({ type: "TP", frac: P.TP_SELL_SMALL, text: `소익절 (+${Math.round(th * 100)}% 달성) · TQQQ ${(P.TP_SELL_SMALL * 100).toFixed(0)}% → SPYM` });
            }
          }
        });

        if (cycleRet >= 1.0) {
          let highest = 0;
          while (Math.pow(2, highest) <= cycleRet) highest++;
          if (highest > bigTpStage) {
            for (let k = 0; k < highest - bigTpStage; k++) {
              const qty = sharesT * P.TP_SELL_BIG;
              if (qty > 0) {
                moveTtoS(qty);
                acts.push({ type: "TP", frac: P.TP_SELL_BIG, text: `대익절 (+${Math.floor(cycleRet * 100)}% 달성) · TQQQ ${(P.TP_SELL_BIG * 100).toFixed(0)}% → SPYM` });
              }
            }
            bigTpStage = highest;
          }
        }
      }
    }

    position = todayPos;

    // 세금 납부: 매년 5월 마지막 거래일 (마지막 봉은 월말 확정 전이라 제외)
    if (i > start && months[i] === 5 && i + 1 < N && months[i + 1] === 6) {
      const toPay = taxesOwed.filter(([y]) => years[i] > y).reduce((s, [, a]) => s + a, 0);
      if (toPay > 0) {
        acts.push({ type: "TAX", text: `세금 납부 ($${toPay.toFixed(0)})` });
        if (cash >= toPay) {
          cash -= toPay;
        } else {
          let rem = toPay - cash;
          cash = 0;
          const valS = sharesS > 0 ? sharesS * cS * (1 - FEE) : 0;
          if (sharesS > 0 && valS >= rem) {
            const sellQty = (rem / (1 - FEE)) / cS;
            const avg = costS / sharesS;
            realizedYear += rem - avg * sellQty;
            sharesS -= sellQty; costS -= avg * sellQty; rem = 0;
          } else {
            if (sharesS > 0) {
              rem -= valS;
              realizedYear += valS - costS;
              sharesS = 0; costS = 0;
            }
            const valT = sharesT > 0 ? sharesT * cT * (1 - FEE) : 0;
            if (sharesT > 0 && valT >= rem) {
              const sellQty = (rem / (1 - FEE)) / cT;
              const avg = costT / sharesT;
              realizedYear += rem - avg * sellQty;
              sharesT -= sellQty; costT -= avg * sellQty; rem = 0;
            } else {
              cash = 0; sharesT = 0; sharesS = 0;
            }
          }
        }
        taxesOwed = taxesOwed.filter(([y]) => y >= years[i]);
      }
    }

    // 연말 정산: 다음 봉이 있고 해가 바뀔 때만 (마지막 봉 제외)
    if (i + 1 < N && years[i] !== years[i + 1]) {
      if (realizedYear > P.DEDUCTION) {
        const tax = (realizedYear - P.DEDUCTION) * P.TAX_RATE;
        taxesOwed.push([years[i], tax]);
        acts.push({ type: "TAX", text: `연말 정산: 세금 확정 ($${tax.toFixed(0)})` });
      }
      realizedYear = 0;
    }

    const totalEq = cash + sharesT * cT + sharesS * cS;
    if (totalEq > peakEq) peakEq = totalEq;
    eq.push(totalEq);
    lastEq = totalEq;
    if (acts.length) events.push({ date: dates[i], acts });
    todayActs = acts;
  }

  const last = N - 1;
  return {
    start, eq, events, cycles, todayActs, position, todayPos,
    state: {
      cash, sharesT, sharesS, buyStage, localPeak, tpFlags, bigTpStage,
      cycleStartEq, rebalanced, totalEq: lastEq, totalTrades, totalTs,
      valT: sharesT * tqqq[last], valS: sharesS * spx[last]
    },
    sma
  };
}

// ------------------------------------------------------------
// 3) 결과 → JSON
// ------------------------------------------------------------
const r2 = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 100) / 100);
const r4 = (v) => Math.round(v * 10000) / 10000;

function buildSignal(sim, P, price) {
  const acts = sim.todayActs;
  const has = (t) => acts.some((a) => a.type === t);
  const lines = [];
  let headline = "", tone = "hold";

  if (has("EXIT")) {
    tone = "sell";
    headline = "하단 밴드 이탈 · 전량 청산";
    lines.push(["TQQQ·SPYM", "전량 매도"], ["SGOV", "전환"]);
  } else if (sim.position === "BELOW") {
    tone = "wait";
    headline = "하락장 · SGOV 대기";
    lines.push(["SGOV", "보유 유지"]);
  } else {
    const buy = acts.find((a) => a.type === "BUY");
    if (has("TS")) {
      tone = "alert";
      headline = "긴급대피 발동 (TS)";
      lines.push(["TQQQ", `${(P.TS_THRESH_SELL * 100).toFixed(0)}% 매도`], ["SPYM", "전환"]);
    }
    if (buy) {
      tone = tone === "alert" ? tone : "buy";
      if (!headline) headline = `${buy.stage}/${P.STAGE_NUM}차 분할매수`;
      lines.push(["TQQQ·SPYM", `${buy.stage}/${P.STAGE_NUM}차 매수`], ["SGOV", "매도"]);
    }
    if (has("REBAL")) {
      if (!headline) headline = "리밸런싱";
      lines.push(["TQQQ·SPYM", `${(P.RB_RATE_T * 10).toFixed(0)}:${(P.RB_RATE_S * 10).toFixed(0)} 리밸런싱`]);
    }
    if (has("TP")) {
      if (!headline) headline = "익절 발동";
      lines.push(["TQQQ", "일부 매도"], ["SPYM", "전환"]);
    }
    if (!lines.length) {
      headline = "상승장 · 보유 유지";
      lines.push(["TQQQ·SPYM", "보유 유지"]);
    }
  }
  return { headline, tone, lines, todayActs: acts };
}

function makePayload(dates, spx, tqqq, meta, P = PARAMS) {
  const N = dates.length;
  const sim = simulate(dates, spx, tqqq, P);
  const s = sim.state;
  const last = N - 1;
  const smaNow = sim.sma[last];
  const bUp = smaNow * (1 + P.UP_BAND);
  const bDown = smaNow * (1 - P.DN_BAND);
  const cSpx = spx[last], cTqqq = tqqq[last];

  const price = {
    spx: r2(cSpx), tqqq: r2(cTqqq), sma: r2(smaNow),
    upBand: r2(bUp), dnBand: r2(bDown),
    toUpPct: r2((bUp / cSpx - 1) * 100),      // 상단 밴드까지 필요한 상승률
    toDnPct: r2((bDown / cSpx - 1) * 100),    // 하단 밴드까지의 하락률
    vsSmaPct: r2((cSpx / smaNow - 1) * 100),
    zone: cSpx >= bUp ? "ABOVE" : cSpx < bDown ? "BELOW" : "IN_BAND"
  };

  const active = sim.position === "ABOVE";
  const total = s.totalEq;
  const cycleRet = active && s.cycleStartEq > 0 ? total / s.cycleStartEq - 1 : null;

  const nextSmall = P.TP_THRESH_HOLDS.filter((_, k) => !s.tpFlags[k]);
  const state = {
    position: sim.position,
    active,
    buy: { filled: active ? Math.min(Math.max(s.buyStage - 1, 0), P.STAGE_NUM) : 0, total: P.STAGE_NUM },
    cycleRet: cycleRet === null ? null : r4(cycleRet),
    ts: active ? {
      peak: r2(s.localPeak),
      trigger: r2(s.localPeak * (1 - P.TS_THRESH)),
      fromPeakPct: r2((cSpx / s.localPeak - 1) * 100),
      toTriggerPct: r2((s.localPeak * (1 - P.TS_THRESH) / cSpx - 1) * 100)
    } : null,
    tp: active ? {
      small: P.TP_THRESH_HOLDS.map((th, k) => ({ th, done: s.tpFlags[k] })),
      nextSmall: nextSmall.length ? nextSmall[0] : null,
      bigStage: s.bigTpStage,
      nextBig: Math.pow(2, s.bigTpStage)   // 다음 대익절 기준 (사이클 수익률 배수: 1.0 = +100%)
    } : null,
    rebalanced: active ? s.rebalanced : null,
    totalTs: s.totalTs
  };

  // 최근 90거래일 차트용
  const from = Math.max(0, N - 90);
  const chart = {
    dates: dates.slice(from),
    spx: spx.slice(from).map(r2),
    sma: sim.sma.slice(from).map(r2),
    up: sim.sma.slice(from).map((v) => r2(v * (1 + P.UP_BAND))),
    dn: sim.sma.slice(from).map((v) => r2(v * (1 - P.DN_BAND)))
  };

  return {
    version: VERSION,
    generatedAt: Math.floor(Date.now() / 1000),
    asOf: meta.time,
    provisional: !!meta.isOpen,
    lastDate: dates[last],
    params: {
      smaN: P.BAND_ROLLING_N, smaLabel: smaLabel(P), name: strategyName(P),
      upBand: P.UP_BAND, dnBand: P.DN_BAND, ts: P.TS_THRESH, tsSell: P.TS_THRESH_SELL,
      stages: P.STAGE_NUM, splitT: P.SPLIT_BUY_RATE_T, splitS: P.SPLIT_BUY_RATE_S,
      rbT: P.RB_RATE_T, rbS: P.RB_RATE_S, tpSmall: P.TP_SELL_SMALL, tpBig: P.TP_SELL_BIG
    },
    price: { ...price, spym: meta.spym === undefined ? null : meta.spym },
    state,
    signal: buildSignal(sim, P, price),
    chart,
    events: sim.events.slice(-8).reverse(),
  };
}

// ------------------------------------------------------------
// 4) HTTP 핸들러
// ------------------------------------------------------------
// override : { spx, tqqq } — 마지막 거래일 종가를 이 값으로 가정한 신호 (자동매매 프로그램의 "만약" 계산용)
async function buildPayload(override) {
  const [spxRaw, tqqqRaw, spym] = await Promise.all([
    fetchYahoo("^GSPC"),
    fetchYahoo("TQQQ"),
    // 실제 주문 수량 계산용 SPYM 현재가 (실패해도 신호는 정상 표시)
    fetchYahoo("SPYM", "5d").then((r) => r.closes[r.closes.length - 1]).catch(() => null)
  ]);
  const tMap = new Map(tqqqRaw.dates.map((d, i) => [d, tqqqRaw.closes[i]]));
  const dates = [], spx = [], tqqq = [];
  spxRaw.dates.forEach((d, i) => {
    if (tMap.has(d)) { dates.push(d); spx.push(spxRaw.closes[i]); tqqq.push(tMap.get(d)); }
  });
  let whatIf = null;
  if (override && dates.length) {
    const last = dates.length - 1;
    if (Number.isFinite(override.spx) && override.spx > 0) spx[last] = override.spx;
    if (Number.isFinite(override.tqqq) && override.tqqq > 0) tqqq[last] = override.tqqq;
    whatIf = { spx: spx[last], tqqq: tqqq[last] };
  }
  const payload = makePayload(dates, spx, tqqq, {
    time: Math.max(spxRaw.time, tqqqRaw.time),
    isOpen: spxRaw.isOpen || tqqqRaw.isOpen,
    spym
  });
  payload.session = { start: spxRaw.sessionStart, end: spxRaw.sessionEnd };   // 정규장 시작·마감 (유닉스 초)
  payload.whatIf = whatIf;
  return payload;
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*"
};

async function handleSignal(request, ctx) {
  // ?spx=...&tqqq=... 이 있으면 캐시 없이 "만약" 계산
  const q = new URL(request.url).searchParams;
  if (q.has("spx") || q.has("tqqq")) {
    try {
      const payload = await buildPayload({ spx: parseFloat(q.get("spx")), tqqq: parseFloat(q.get("tqqq")) });
      return new Response(JSON.stringify(payload), { headers: { ...JSON_HEADERS, "Cache-Control": "no-store" } });
    } catch (err) {
      return new Response(JSON.stringify({ error: String((err && err.message) || err) }), {
        status: 500, headers: { ...JSON_HEADERS, "Cache-Control": "no-store" }
      });
    }
  }
  const cache = caches.default;
  const cacheKey = new Request(new URL("/__cache/signal", request.url).toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    const payload = await buildPayload();
    const res = new Response(JSON.stringify(payload), {
      headers: { ...JSON_HEADERS, "Cache-Control": `public, max-age=${CACHE_SECONDS}` }
    });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err && err.message) || err) }), {
      status: 500,
      headers: { ...JSON_HEADERS, "Cache-Control": "no-store" }
    });
  }
}

// ------------------------------------------------------------
// 5) 텔레그램 알림
// ------------------------------------------------------------
// 미국 동부시간 기준 날짜(YYYY-MM-DD)와 분(0~1439)
function etNow(ms = Date.now()) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });
  const o = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${o.year}-${o.month}-${o.day}`, min: +o.hour * 60 + +o.minute };
}

const pct = (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;

// 사전 알림: 오늘 밤 미국장에서 날 수 있는 신호 (어제 종가 기준, SPX가 X% 안쪽으로 움직이면)
function preAlertReasons(p, X) {
  const s = p.state, pr = p.price, out = [];
  if (s.position !== "ABOVE") {
    if (pr.toUpPct <= X) out.push(`진입(1차 분할매수): SPX가 ${pct(pr.toUpPct)} 이상 오르면 상단 밴드 돌파`);
    return out;
  }
  const buying = s.buy && s.buy.filled < s.buy.total;
  if (buying) out.push(`분할매수 ${s.buy.filled + 1}/${s.buy.total}차 예정 (하단 밴드 이탈만 없으면 확정)`);
  if (pr.toDnPct >= -X) out.push(`전량 청산(EXIT): SPX가 ${pct(pr.toDnPct)} 이상 내리면 하단 밴드 이탈`);
  if (!buying && s.ts && s.ts.toTriggerPct >= -X) out.push(`TS: SPX가 ${pct(s.ts.toTriggerPct)} 이상 내리면 발동`);
  if (!buying && s.rebalanced === false && pr.zone === "ABOVE" && pr.toUpPct >= -X)
    out.push(`리밸런싱: SPX가 ${pct(pr.toUpPct)} 이상 내려 밴드 안으로 들어오면`);
  if (s.tp && s.cycleRet !== null) {
    // 사이클 수익률은 대략 SPX의 3배 가까이 움직이므로 X×3 안쪽이면 알림
    const near = [s.tp.nextSmall, s.tp.nextBig].filter((t) => t !== null && t !== undefined && t > s.cycleRet
      && (t - s.cycleRet) * 100 <= X * 3);
    if (near.length) out.push(`익절(TP): 사이클 수익률 ${(s.cycleRet * 100).toFixed(1)}% → 기준 ${(Math.min(...near) * 100).toFixed(0)}%`);
  }
  return out;
}

function tradeActs(p) {
  return (p.signal.todayActs || []).filter((a) => TRADE_TYPES.includes(a.type));
}

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 비밀값이 없습니다");
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true })
  });
  if (!res.ok) throw new Error(`텔레그램 전송 실패 (HTTP ${res.status}) ${await res.text()}`);
}

// 알림에 쓰는 이름·이동평균 표시 (신호 계산에 쓴 PARAMS 값을 그대로 따름)
const nameOf = (p) => (p.params && p.params.name) || strategyName();
const smaOf = (p) => (p.params && p.params.smaLabel) || smaLabel();

function priceLine(p) {
  const pr = p.price, f = (v) => v.toLocaleString("en-US");
  return `SPX ${f(pr.spx)} · ${smaOf(p)} ${f(pr.sma)} (상단 ${f(pr.upBand)} · 하단 ${f(pr.dnBand)})`;
}

// 사전 알림 문구 (없으면 null)
function preMessage(p, force = false) {
  const reasons = preAlertReasons(p, ALERT.PRE_ALERT_PCT);
  if (!reasons.length && !force) return null;
  return [
    `🔔 [${nameOf(p)}] 오늘 밤 매매 신호 가능`,
    `기준: ${p.lastDate} 종가 · ${priceLine(p)}`,
    ...(reasons.length ? reasons.map((r) => "• " + r) : ["• (테스트) 지금은 해당하는 신호가 없습니다"]),
    "→ 자동매매 프로그램을 켜 두세요.",
    ALERT.PAGE_URL
  ].join("\n");
}

// 확정 알림 문구 (없으면 null)
function postMessage(p, force = false) {
  const acts = tradeActs(p);
  if (!acts.length && !force) return null;
  return [
    `✅ [${nameOf(p)}] ${p.lastDate} 종가 신호 확정: ${p.signal.headline}`,
    ...(acts.length ? acts.map((a) => "• " + a.text) : ["• (테스트) 오늘은 매매 신호가 없습니다"]),
    priceLine(p),
    ALERT.PAGE_URL
  ].join("\n");
}

async function handleScheduled(event, env) {
  const now = etNow(event.scheduledTime);
  if (event.cron === "30 12 * * 1-5") {                  // 한국시간 21:30 사전 알림
    if (!ALERT.PRE_ALERT) return;
    const p = await buildPayload();
    const end = p.session && p.session.end ? etNow(p.session.end * 1000).date : null;
    if (end && end !== now.date) return;                   // 오늘 미국 휴장
    const msg = preMessage(p);
    if (msg) await sendTelegram(env, msg);
    return;
  }
  // 확정 알림: 16:20 ET (서머타임·겨울 두 개의 cron 중 동부시간 16시대에 맞는 것만 실행)
  if (now.min < 16 * 60 + 5 || now.min >= 17 * 60) return;
  const p = await buildPayload();
  if (p.provisional || p.lastDate !== now.date) return;   // 휴장일이거나 아직 종가 미확정
  const msg = postMessage(p);
  if (msg) await sendTelegram(env, msg);
}

// 알림 시험: /api/telegram-test?key=<TELEGRAM_CHAT_ID>&mode=pre|post  (신호가 없어도 지금 상태로 한 번 보냄)
async function handleTelegramTest(request, env) {
  const q = new URL(request.url).searchParams;
  if (!env.TELEGRAM_CHAT_ID || q.get("key") !== String(env.TELEGRAM_CHAT_ID)) {
    return new Response("key가 맞지 않습니다", { status: 403 });
  }
  try {
    const p = await buildPayload();
    const text = q.get("mode") === "post" ? postMessage(p, true) : preMessage(p, true);
    await sendTelegram(env, text);
    return new Response("보냈습니다:\n\n" + text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch (err) {
    return new Response("실패: " + String((err && err.message) || err), { status: 500 });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/signal") return handleSignal(request, ctx);
    if (url.pathname === "/api/telegram-test") return handleTelegramTest(request, env);
    return env.ASSETS.fetch(request);   // 나머지는 public/ 정적 파일
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  }
};
