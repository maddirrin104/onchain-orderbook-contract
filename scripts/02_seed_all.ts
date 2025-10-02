import { network } from "hardhat";
import "dotenv/config";

// enum giống Solidity
enum Side { BUY, SELL }

// ====== cấu hình qua env (tuỳ chọn) ======
const N_LEVELS = Number(process.env.LEVELS ?? 10);      // số level mỗi phía
const K_TRADES = Number(process.env.TRADES ?? 40);      // số giao dịch tạo thêm
const STEP_BPS  = Number(process.env.STEP_BPS ?? 10);   // khoảng cách giữa các level, đơn vị bps (10 = 0.10%)
const ONLY_SYMBOL = process.env.ONLY_SYMBOL;            // seed riêng 1 symbol nếu set

// scale helpers
const P = (x: number, priceDec = 8) => {
  const mul = 10 ** priceDec;
  return BigInt(Math.round(x * mul));
};
const A = (ethers: any, x: number, baseDec: number) =>
  ethers.parseUnits(x.toString(), baseDec);

// random helper
const rnd = (min: number, max: number) => min + Math.random() * (max - min);

async function main() {
  const { ethers } = await network.connect();

  const obAddr = process.env.OB_ADDR as `0x${string}`;
  if (!obAddr) throw new Error("Missing OB_ADDR (địa chỉ OnchainOrderBook)");

  const ob = await ethers.getContractAt("OnchainOrderBook", obAddr);

  // Oracle
  const oracleAddr = await ob.oracle();
  const oracle = await ethers.getContractAt("OracleRouter", oracleAddr);

  const [sA, sB, sC] = await ethers.getSigners();

  const nextPairId = await ob.nextPairId();
  const totalPairs = Number(nextPairId) - 1;
  if (totalPairs <= 0) {
    console.log("Chưa có cặp nào. Hãy chạy 01_deploy_all.ts trước.");
    return;
  }

  console.log(`Deep seeding ${totalPairs} pairs... (LEVELS=${N_LEVELS}, TRADES=${K_TRADES}, STEP_BPS=${STEP_BPS})`);

  for (let pairId = 1; pairId <= totalPairs; pairId++) {
    // 1) Meta
    const [symbol, priceDecBN, baseDecBN] = await ob.getPairMeta(pairId);
    if (ONLY_SYMBOL && symbol !== ONLY_SYMBOL) {
      continue; // bỏ qua nếu user chỉ muốn 1 symbol
    }
    const priceDecimals = Number(priceDecBN);
    const baseDecimals  = Number(baseDecBN);

    // 2) Mark price từ oracle
    const [answer, feedDec /*, updatedAt*/] = await oracle.getLatestPrice(symbol);
    const mark = Number(answer) / 10 ** Number(feedDec);
    const markSafe = mark > 0 ? mark : 10;

    // 3) Tạo N level mỗi phía
    for (let i = 1; i <= N_LEVELS; i++) {
      const delta = (STEP_BPS * i) / 10_000;     // ví dụ 10 bps = 0.001
      const bidPx = markSafe * (1 - delta);
      const askPx = markSafe * (1 + delta);

      // size ngẫu nhiên một chút cho đẹp, tuỳ theo decimals
      const szBid = baseDecimals >= 18 ? rnd(0.3, 1.6) : rnd(30, 160);
      const szAsk = baseDecimals >= 18 ? rnd(0.3, 1.6) : rnd(30, 160);

      const makerB = i % 2 ? sA : sB;
      const makerS = i % 2 ? sB : sA;

      await (await ob.connect(makerB).placeLimitOrder(
        pairId, Side.BUY,  P(bidPx, priceDecimals), A(ethers, szBid, baseDecimals)
      )).wait();

      await (await ob.connect(makerS).placeLimitOrder(
        pairId, Side.SELL, P(askPx, priceDecimals), A(ethers, szAsk, baseDecimals)
      )).wait();
    }

    // 4) Bơm K giao dịch ngẫu nhiên (BUY/SELL) để có nhiều recent trades
    //    Dùng giá chạm best đối ứng (mark ± epsilon) để chắc chắn cross
    const EPS = 0.0002; // 2 bps
    for (let k = 0; k < K_TRADES; k++) {
      const takerSide = Math.random() < 0.5 ? Side.BUY : Side.SELL;
      const px = takerSide === Side.BUY
        ? markSafe * (1 + EPS)   // BUY: >= best ask
        : markSafe * (1 - EPS);  // SELL: <= best bid

      const amt = baseDecimals >= 18 ? rnd(0.10, 0.70) : rnd(10, 70);
      const who = k % 3 === 0 ? sC : (k % 3 === 1 ? sA : sB);

      await (await ob.connect(who).placeLimitOrder(
        pairId, takerSide, P(px, priceDecimals), A(ethers, amt, baseDecimals)
      )).wait();
    }

    console.log(`[OK+] Deep seeded #${pairId} (${symbol}) @ mark≈${markSafe.toFixed(6)}`);
  }

  console.log("===> Done. Orderbook dày hơn + nhiều recent trades.");
}

main().catch((e) => { console.error(e); process.exit(1); });
