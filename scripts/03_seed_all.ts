import { network } from "hardhat";
import "dotenv/config";

// Sides giống enum trong Solidity
enum Side {
  BUY,
  SELL,
}

// scale helpers
const P = (x: number, priceDec = 8) => {
  const mul = 10 ** priceDec;
  return BigInt(Math.round(x * mul));
};

const toUnits = (ethers: any, x: number, decimals: number) => {
  const frac = Math.min(decimals, 6);
  const s = x.toFixed(frac);
  return ethers.parseUnits(s, decimals);
};

const A = (ethers: any, x: number, baseDec: number) =>
  toUnits(ethers, x, baseDec);

const Q = (ethers: any, x: number, quoteDec: number) =>
  toUnits(ethers, x, quoteDec);


async function main() {
  const { ethers } = await network.connect();

  const obAddr = process.env.OB_ADDR as `0x${string}`;
  if (!obAddr) throw new Error("Missing OB_ADDR (địa chỉ OnchainOrderBook)");

  const ob = await ethers.getContractAt("OnchainOrderBook", obAddr) as any;

  const oracleAddr = await ob.oracle();
  const oracle = await ethers.getContractAt("OracleRouter", oracleAddr);

  const signers = await ethers.getSigners();
  const sA = signers[0];
  const sB = signers[1];
  const sC = signers[2];

  // Số lượng cặp = nextPairId - 1
  const nextPairId = await ob.nextPairId();
  const totalPairs = Number(nextPairId) - 1;

  if (totalPairs <= 0) {
    console.log("Chưa có cặp nào. Hãy chạy 01_deploy_all.ts trước.");
    return;
  }

  console.log(`Seeding ${totalPairs} pairs...`);

  for (let pairId = 1; pairId <= totalPairs; pairId++) {
    // 1) Meta
    const meta = await ob.getPairMeta(pairId);
    const symbol = meta[0] as string;
    const priceDecimals = Number(meta[1]);
    const baseDecimals  = Number(meta[2]);
    const quoteDecimals = Number(meta[3]);

    // 2) Mark price từ oracle
    const [answer, feedDec /*, updatedAt*/] = await oracle.getLatestPrice(symbol);
    const mark = Number(answer) / 10 ** Number(feedDec);
    const markSafe = mark > 0 ? mark : 10;

    // 3) Lấy token
    const [baseTokenAddr, quoteTokenAddr] = await ob.getPairTokens(pairId);
    const baseToken  = await ethers.getContractAt("MockERC20", baseTokenAddr);
    const quoteToken = await ethers.getContractAt("MockERC20", quoteTokenAddr);

    // 4) Mint + approve + deposit cho mỗi signer
    for (const s of [sA, sB, sC]) {
      const baseDep = A(ethers, 1_000, baseDecimals);
      await (await baseToken.connect(s).mint(s.address, baseDep)).wait();
      await (await baseToken.connect(s).approve(obAddr, baseDep)).wait();
      await (await ob.connect(s).depositBase(pairId, baseDep)).wait();

      const quoteDep = Q(ethers, 1_000 * markSafe * 2, quoteDecimals);
      await (await quoteToken.connect(s).mint(s.address, quoteDep)).wait();
      await (await quoteToken.connect(s).approve(obAddr, quoteDep)).wait();
      await (await ob.connect(s).depositQuote(pairId, quoteDep)).wait();
    }

    // 5) Tạo 2 BID & 2 ASK quanh mark
    const pxBid1 = markSafe * 0.99;
    const pxBid2 = markSafe * 0.995;
    const pxAsk1 = markSafe * 1.005;
    const pxAsk2 = markSafe * 1.01;

    const sizeBig   = baseDecimals >= 18 ? 1.2 : 120;
    const sizeMid   = baseDecimals >= 18 ? 0.8 : 80;
    const sizeSmall = baseDecimals >= 18 ? 0.5 : 50;

    // BIDs
    await (await ob.connect(sA).placeLimitOrder(
      pairId,
      Side.BUY,
      P(pxBid1, priceDecimals),
      A(ethers, sizeBig, baseDecimals)
    )).wait();

    await (await ob.connect(sB).placeLimitOrder(
      pairId,
      Side.BUY,
      P(pxBid2, priceDecimals),
      A(ethers, sizeMid, baseDecimals)
    )).wait();

    // ASKs
    await (await ob.connect(sA).placeLimitOrder(
      pairId,
      Side.SELL,
      P(pxAsk1, priceDecimals),
      A(ethers, sizeBig, baseDecimals)
    )).wait();

    await (await ob.connect(sB).placeLimitOrder(
      pairId,
      Side.SELL,
      P(pxAsk2, priceDecimals),
      A(ethers, sizeMid, baseDecimals)
    )).wait();

    // 6) Taker BUY để tạo trade
    await (await ob.connect(sC).placeLimitOrder(
      pairId,
      Side.BUY,
      P(pxAsk1, priceDecimals),
      A(ethers, sizeSmall, baseDecimals)
    )).wait();

    console.log(`[OK] Seeded pair #${pairId} (${symbol}) @ mark≈${markSafe.toFixed(6)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
