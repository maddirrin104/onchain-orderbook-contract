// scripts/06_benchmarks.ts
import { network } from "hardhat";
import fs from "fs";

const WAD = 10n ** 18n;
const SIDE = { BUY: 0, SELL: 1 } as const;

type BenchContext = {
  ethers: any;
  ob: any;
  base: any;
  quote: any;
  oracle: any;
  agg: any;
  pairId: number;
  deployer: any;
  maker: any;
  taker: any;
};

type TxMetric = {
  gasUsed: bigint;
  latencyMs: number;
};

function summarize(arr: number[]) {
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const p50 = sorted[Math.floor(0.5 * (n - 1))];
  const p95 = sorted[Math.floor(0.95 * (n - 1))];
  return {
    min: sorted[0],
    max: sorted[n - 1],
    mean,
    p50,
    p95,
  };
}

function summarizeBig(arr: bigint[]) {
  const nums = arr.map(Number);
  const s = summarize(nums);
  return {
    min: BigInt(s.min),
    max: BigInt(s.max),
    mean: s.mean,
    p50: BigInt(s.p50),
    p95: BigInt(s.p95),
  };
}

async function sendAndMeasure(
  fn: () => Promise<any>
): Promise<TxMetric> {
  const t0 = Date.now();
  const tx = await fn();           // send tx
  const receipt = await tx.wait(); // wait mined
  const t1 = Date.now();
  return {
    gasUsed: receipt.gasUsed as bigint,
    latencyMs: t1 - t0,
  };
}

/**
 * Deploy OracleRouter + MockAggregator + MockERC20 + OnchainOrderBook
 * Tạo 1 pair "ETH - USD" + nạp tiền cho 2 trader.
 */
async function setupFresh(ethers: any): Promise<BenchContext> {
  const [deployer, maker, taker] = await ethers.getSigners();

  // Deploy oracle + mock aggregator
  const OracleRouterF = await ethers.getContractFactory("OracleRouter");
  const oracle = await OracleRouterF.deploy(await deployer.getAddress());
  await oracle.waitForDeployment();

  const MockAggF = await ethers.getContractFactory("MockAggregatorV3");
  const priceEthUsd = 2_000n * WAD; // 2000 USD
  const agg = await MockAggF.deploy(18, priceEthUsd);
  await agg.waitForDeployment();

  await (await oracle.setFeed("ETH - USD", await agg.getAddress())).wait();

  // Deploy tokens
  const MockERC20F = await ethers.getContractFactory("MockERC20");
  const base = await MockERC20F.deploy("Mock ETH", "mETH", 18);
  await base.waitForDeployment();
  const quote = await MockERC20F.deploy("Mock USD", "mUSD", 18);
  await quote.waitForDeployment();

  // Deploy orderbook
  const OB = await ethers.getContractFactory("OnchainOrderBook");
  const ob = await OB.deploy(await oracle.getAddress());
  await ob.waitForDeployment();

  // Add pair (id sẽ là 1 cho orderbook mới)
  await (
    await ob.addPair(
      "ETH - USD",
      18, // priceDecimals
      18, // baseDecimals
      18, // quoteDecimals
      await base.getAddress(),
      await quote.getAddress()
    )
  ).wait();
  const pairId = 1;

  // Mint & deposit funds
  const BASE_SUPPLY = 1_000_000n * WAD;
  const QUOTE_SUPPLY = 1_000_000n * WAD;

  // maker có base để SELL
  await (await base.mint(await maker.getAddress(), BASE_SUPPLY)).wait();
  await (
    await base
      .connect(maker)
      .approve(await ob.getAddress(), BASE_SUPPLY)
  ).wait();
  await (
    await ob
      .connect(maker)
      .depositBase(pairId, BASE_SUPPLY)
  ).wait();

  // taker có quote để BUY
  await (await quote.mint(await taker.getAddress(), QUOTE_SUPPLY)).wait();
  await (
    await quote
      .connect(taker)
      .approve(await ob.getAddress(), QUOTE_SUPPLY)
  ).wait();
  await (
    await ob
      .connect(taker)
      .depositQuote(pairId, QUOTE_SUPPLY)
  ).wait();

  return {
    ethers,
    ob,
    base,
    quote,
    oracle,
    agg,
    pairId,
    deployer,
    maker,
    taker,
  };
}

/**
 * Pre-populate orderbook với một dãy SELL ở phía maker
 * price = (basePrice + i * tick) * 1e18 , size = amountEach
 */
async function seedSellLadder(
  ctx: BenchContext,
  levels: number,
  basePrice: bigint,
  tick: bigint,
  amountEach: bigint
) {
  const { ob, pairId, maker } = ctx;

  for (let i = 0; i < levels; i++) {
    const px = basePrice + BigInt(i) * tick;
    await (
      await ob
        .connect(maker)
        .placeLimitOrder(pairId, SIDE.SELL, px, amountEach)
    ).wait();
  }
}

/* ===================== 1) LATENCY ===================== */

async function benchmarkLatency(ctx: BenchContext) {
  console.log("=== Benchmark: LATENCY ===");

  const { ob, pairId, taker } = ctx;

  // Sổ lệnh có sẵn 16 mức SELL
  const PRICE0 = 2_000n * WAD;
  const TICK = 10n * WAD; // 10 USD
  const LEVELS = 16;
  const AMOUNT_PER_LEVEL = 1n * WAD; // 1 ETH mỗi mức

  await seedSellLadder(ctx, LEVELS, PRICE0, TICK, AMOUNT_PER_LEVEL);

  // Taker đặt BUY limit trên best ask -> sẽ khớp ngay
  const N = 30; // số tx để đo
  const buyPrice = PRICE0 + 5n * TICK; // trên best ask
  const buyAmount = WAD / 10n; // 0.1 ETH

  const latencies: number[] = [];
  const gasArr: bigint[] = [];

  for (let i = 0; i < N; i++) {
    const metric = await sendAndMeasure(() =>
      ob
        .connect(taker)
        .placeLimitOrder(pairId, SIDE.BUY, buyPrice, buyAmount)
    );
    latencies.push(metric.latencyMs);
    gasArr.push(metric.gasUsed);
  }

  const latStat = summarize(latencies);
  const gasStat = summarizeBig(gasArr);

  console.log("Latency ms (BUY taker, N = %d):", N, latStat);
  console.log("Gas used:", gasStat);

  const lines = [
    "run,latency_ms,gas_used",
    ...latencies.map((l, idx) => `${idx},${l},${gasArr[idx].toString()}`),
  ];
  fs.writeFileSync("logs/latency_results.csv", lines.join("\n"), "utf8");
  console.log('logs/Saved latency_results.csv');
}

/* ===================== 2) THROUGHPUT ===================== */

async function benchmarkThroughput(ctx: BenchContext) {
  console.log("=== Benchmark: THROUGHPUT ===");

  const { ob, pairId, maker, taker } = ctx;

  // Đảm bảo sổ lệnh có một ít liquidity hai phía
  const PRICE_MID = 2_000n * WAD;
  const TICK = 5n * WAD;
  const AMOUNT = WAD / 10n;

  // Maker đặt một ít SELL và BUY quanh mid
  for (let i = 0; i < 5; i++) {
    const askPx = PRICE_MID + BigInt(i) * TICK;
    const bidPx = PRICE_MID - BigInt(i + 1) * TICK;

    await (
      await ob
        .connect(maker)
        .placeLimitOrder(pairId, SIDE.SELL, askPx, AMOUNT)
    ).wait();

    await (
      await ob
        .connect(maker)
        .placeLimitOrder(pairId, SIDE.BUY, bidPx, AMOUNT)
    ).wait();
  }

  const N_TX = 100; // số tx để đo throughput
  const takerPriceBuy = PRICE_MID + 2n * TICK;
  const takerPriceSell = PRICE_MID - 2n * TICK;

  const latencies: number[] = [];
  const gasArr: bigint[] = [];

  const t0 = Date.now();
  for (let i = 0; i < N_TX; i++) {
    const isBuy = i % 2 === 0;
    const metric = await sendAndMeasure(() =>
      ob
        .connect(isBuy ? taker : maker) // luân phiên 2 phía cho vui
        .placeLimitOrder(
          pairId,
          isBuy ? SIDE.BUY : SIDE.SELL,
          isBuy ? takerPriceBuy : takerPriceSell,
          AMOUNT
        )
    );

    latencies.push(metric.latencyMs);
    gasArr.push(metric.gasUsed);
  }
  const t1 = Date.now();
  const elapsedSec = (t1 - t0) / 1000;

  const txPerSec = N_TX / elapsedSec;
  const latStat = summarize(latencies);
  const gasStat = summarizeBig(gasArr);

  console.log("Total time (s):", elapsedSec.toFixed(3));
  console.log("Throughput (tx/s):", txPerSec.toFixed(2));
  console.log("Latency stats (ms):", latStat);
  console.log("Gas stats:", gasStat);

  const lines = [
    "run,latency_ms,gas_used",
    ...latencies.map((l, idx) => `${idx},${l},${gasArr[idx].toString()}`),
  ];
  fs.writeFileSync("logs/throughput_results.csv", lines.join("\n"), "utf8");
  console.log("Saved logs/throughput_results.csv");
}

/* ===================== 3) SENSITIVITY ANALYSIS ===================== */
/**
 * Sensitivity: thay đổi độ sâu sổ lệnh (số mức giá SELL đang tồn tại)
 * và đo gas + latency của 1 lệnh BUY lớn quét hết book.
 */
async function benchmarkSensitivity(ethers: any) {
  console.log("=== Benchmark: SENSITIVITY (depth) ===");

  const DEPTHS = [0, 4, 8, 16, 32];
  const AMOUNT_PER_LEVEL = 1n * WAD;
  const PRICE0 = 2_000n * WAD;
  const TICK = 10n * WAD;

  const lines = ["depth_levels,gas_used,latency_ms"];

  for (const depth of DEPTHS) {
    // Mỗi độ sâu deploy 1 bộ contract mới để “reset” trạng thái
    const ctx = await setupFresh(ethers);
    const { ob, pairId, maker, taker } = ctx;

    if (depth > 0) {
      await seedSellLadder(ctx, depth, PRICE0, TICK, AMOUNT_PER_LEVEL);
    }

    // Taker BUY 1 lệnh quét hết (depth * AMOUNT_PER_LEVEL)
    const totalAmount = BigInt(depth) * AMOUNT_PER_LEVEL || 1n * WAD; // depth=0 thì cứ 1 ETH
    const takerPrice = PRICE0 + BigInt(depth + 2) * TICK; // cao hơn tất cả ask

    const metric = await sendAndMeasure(() =>
      ob
        .connect(taker)
        .placeLimitOrder(pairId, SIDE.BUY, takerPrice, totalAmount)
    );

    console.log(
      `Depth=${depth}: gas=${metric.gasUsed.toString()}, latency=${metric.latencyMs} ms`
    );

    lines.push(`${depth},${metric.gasUsed.toString()},${metric.latencyMs}`);
  }

  fs.writeFileSync("logs/sensitivity_depth_results.csv", lines.join("\n"), "utf8");
  console.log("Saved logs/sensitivity_depth_results.csv");
}

/* ===================== MAIN ===================== */

async function main() {
  const { ethers } = await network.connect();

  // 1) Latency + Throughput dùng chung một lần setup
  const ctx = await setupFresh(ethers);
  await benchmarkLatency(ctx);
  await benchmarkThroughput(ctx);

  // 2) Sensitivity: tự deploy lại mỗi scenario
  await benchmarkSensitivity(ethers);

  console.log("All benchmarks done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
