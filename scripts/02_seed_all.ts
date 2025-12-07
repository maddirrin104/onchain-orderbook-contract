// scripts/02_seed_all.ts
import { network } from "hardhat";
import "dotenv/config";

enum Side { BUY, SELL }

const N_LEVELS = Number(process.env.LEVELS ?? 10);
const K_TRADES = Number(process.env.TRADES ?? 40);
const STEP_BPS  = Number(process.env.STEP_BPS ?? 10);
const ONLY_SYMBOL = process.env.ONLY_SYMBOL;

const P = (x: number, priceDec = 8) => {
  const mul = 10 ** priceDec;
  return BigInt(Math.round(x * mul));
};
// Chuyển number -> BigInt với giới hạn số lẻ
const toUnits = (ethers: any, x: number, decimals: number) => {
  // chỉ giữ tối đa 6 số lẻ để tránh chuỗi quá dài
  const frac = Math.min(decimals, 6);
  const s = x.toFixed(frac); // ví dụ 128.531860
  return ethers.parseUnits(s, decimals);
};

const A = (ethers: any, x: number, baseDec: number) =>
  toUnits(ethers, x, baseDec);
const Q = (ethers: any, x: number, quoteDec: number) =>
  toUnits(ethers, x, quoteDec);


// random helper
const rnd = (min: number, max: number) => min + Math.random() * (max - min);

async function main() {
  const { ethers } = await network.connect();

  const obAddr = process.env.OB_ADDR as `0x${string}`;
  if (!obAddr) throw new Error("Missing OB_ADDR");

  const ob = await ethers.getContractAt("OnchainOrderBook", obAddr);
  const oracleAddr = await (ob as any).oracle();
  const oracle = await ethers.getContractAt("OracleRouter", oracleAddr);

  const [sA, sB, sC] = await ethers.getSigners();

  const nextPairId = await (ob as any).nextPairId();
  const totalPairs = Number(nextPairId) - 1;
  if (totalPairs <= 0) {
    console.log("Chưa có cặp nào. Hãy chạy 01_deploy_all.ts trước.");
    return;
  }

  console.log(
    `Deep seeding ${totalPairs} pairs... (LEVELS=${N_LEVELS}, TRADES=${K_TRADES}, STEP_BPS=${STEP_BPS})`
  );

  for (let pairId = 1; pairId <= totalPairs; pairId++) {
    // 1) Meta
    const [symbol, priceDecBN, baseDecBN, quoteDecBN] = await (ob as any).getPairMeta(pairId);
    if (ONLY_SYMBOL && symbol !== ONLY_SYMBOL) continue;

    const priceDecimals = Number(priceDecBN);
    const baseDecimals  = Number(baseDecBN);
    const quoteDecimals = Number(quoteDecBN);

    // 1.1) Lấy token address
    const [baseTokenAddr, quoteTokenAddr] = await (ob as any).getPairTokens(pairId);
    const baseToken  = await ethers.getContractAt("MockERC20", baseTokenAddr);
    const quoteToken = await ethers.getContractAt("MockERC20", quoteTokenAddr);

    // 2) Mark price từ oracle (price, decimals, updatedAt)
    const [answer, feedDec /*, updatedAt*/] = await (oracle as any).getLatestPrice(symbol);
    const mark = Number(answer) / 10 ** Number(feedDec);
    const markSafe = mark > 0 ? mark : 10;

    // 2.1) Mint + approve + deposit cho 3 signer
    const signers = [sA, sB, sC];
    for (const s of signers) {
      const baseDep = A(ethers, 10_000, baseDecimals);
      await (await baseToken.connect(s).mint(s.address, baseDep)).wait();
      await (await baseToken.connect(s).approve(obAddr, baseDep)).wait();
      await (await (ob as any).connect(s).depositBase(pairId, baseDep)).wait();

      const quoteDep = Q(ethers, 10_000 * markSafe * 2, quoteDecimals);
      await (await quoteToken.connect(s).mint(s.address, quoteDep)).wait();
      await (await quoteToken.connect(s).approve(obAddr, quoteDep)).wait();
      await (await (ob as any).connect(s).depositQuote(pairId, quoteDep)).wait();
    }

    // 3) Tạo N level mỗi phía
    for (let i = 1; i <= N_LEVELS; i++) {
      const delta = (STEP_BPS * i) / 10_000;
      const bidPx = markSafe * (1 - delta);
      const askPx = markSafe * (1 + delta);

      const szBid = baseDecimals >= 18 ? rnd(0.3, 1.6) : rnd(30, 160);
      const szAsk = baseDecimals >= 18 ? rnd(0.3, 1.6) : rnd(30, 160);

      const makerB = i % 2 ? sA : sB;
      const makerS = i % 2 ? sB : sA;

      await (
        await (ob as any)
          .connect(makerB)
          .placeLimitOrder(
            pairId,
            Side.BUY,
            P(bidPx, priceDecimals),
            A(ethers, szBid, baseDecimals)
          )
      ).wait();

      await (
        await (ob as any)
          .connect(makerS)
          .placeLimitOrder(
            pairId,
            Side.SELL,
            P(askPx, priceDecimals),
            A(ethers, szAsk, baseDecimals)
          )
      ).wait();
    }

    // 4) Bơm K giao dịch cross
    const EPS = 0.0002;
    for (let k = 0; k < K_TRADES; k++) {
      const takerSide = Math.random() < 0.5 ? Side.BUY : Side.SELL;
      const px =
        takerSide === Side.BUY
          ? markSafe * (1 + EPS)
          : markSafe * (1 - EPS);

      const amt = baseDecimals >= 18 ? rnd(0.1, 0.7) : rnd(10, 70);
      const who = k % 3 === 0 ? sC : k % 3 === 1 ? sA : sB;

      await (
        await (ob as any)
          .connect(who)
          .placeLimitOrder(
            pairId,
            takerSide,
            P(px, priceDecimals),
            A(ethers, amt, baseDecimals)
          )
      ).wait();
    }

    console.log(
      `[OK+] Deep seeded #${pairId} (${symbol}) @ mark≈${markSafe.toFixed(6)}`
    );
  }

  console.log("===> Done. Orderbook dày + nhiều recent trades.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
