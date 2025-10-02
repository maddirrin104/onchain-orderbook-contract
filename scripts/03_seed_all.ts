import { network } from "hardhat";
import "dotenv/config";

// Sides giống enum trong Solidity
enum Side {
  BUY,
  SELL,
}

// scale helpers
const P = (x: number, priceDec = 8) => {
  // giữ 8 mặc định trừ khi pair dùng priceDecimals khác
  const mul = 10 ** priceDec;
  return BigInt(Math.round(x * mul));
};

const A = (ethers: any, x: number, baseDec: number) =>
  ethers.parseUnits(x.toString(), baseDec);

async function main() {
  const { ethers } = await network.connect();

  const obAddr = process.env.OB_ADDR as `0x${string}`;
  if (!obAddr) throw new Error("Missing OB_ADDR (địa chỉ OnchainOrderBook)");

  const ob = await ethers.getContractAt("OnchainOrderBook", obAddr);

  // Lấy địa chỉ OracleRouter từ biến public "oracle" của orderbook
  const oracleAddr = await ob.oracle();
  const oracle = await ethers.getContractAt("OracleRouter", oracleAddr);

  const signers = await ethers.getSigners();
  // dùng 3 signer khác nhau để tạo maker/taker tự nhiên
  const sA = signers[0];
  const sB = signers[1];
  const sC = signers[2];

  // Xác định số lượng cặp đã được addPair
  const nextPairId = await ob.nextPairId();
  const totalPairs = Number(nextPairId) - 1;

  if (totalPairs <= 0) {
    console.log("Chưa có cặp nào. Hãy chạy 01_deploy_all.ts trước.");
    return;
  }

  console.log(`Seeding ${totalPairs} pairs...`);

  for (let pairId = 1; pairId <= totalPairs; pairId++) {
    // 1) Lấy meta
    const meta = await ob.getPairMeta(pairId);
    const symbol = meta[0] as string;
    const priceDecimals = Number(meta[1]);
    const baseDecimals = Number(meta[2]);
    // const quoteDecimals = Number(meta[3]); // chỉ metadata hiển thị

    // 2) Lấy mark price từ oracle
    const [answer, feedDec /*, updatedAt*/] = await oracle.getLatestPrice(symbol);
    const mark = Number(answer) / 10 ** Number(feedDec);

    // Nếu mark price <= 0 (hiếm khi), đặt mark 10 cho an toàn
    const markSafe = mark > 0 ? mark : 10;

    // 3) Tạo các mức giá quanh mark (ví dụ ±1%, ±0.5%)
    const pxBid1 = markSafe * 0.99;
    const pxBid2 = markSafe * 0.995;
    const pxAsk1 = markSafe * 1.005;
    const pxAsk2 = markSafe * 1.01;

    // 4) Khối lượng demo (tuỳ theo baseDecimals)
    // - token 18 decimals: vài đơn vị
    // - token 6/8 decimals: vài tens/hundreds để nhìn rõ
    const sizeBig = baseDecimals >= 18 ? 1.2 : 120; // maker lớn
    const sizeMid = baseDecimals >= 18 ? 0.8 : 80;  // maker vừa
    const sizeSmall = baseDecimals >= 18 ? 0.5 : 50; // taker nhỏ để cross

    // 5) Đặt lệnh:
    // - Tạo 2 mức BID & 2 mức ASK
    // - Sau đó đặt 1 lệnh TAKER để cross @best ask (đối với BUY) giúp sinh trade
    // - Lặp lại mô hình cho mỗi pair

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

    // TAKER BUY @ best ask (pxAsk1) để tạo ít nhất 1 trade
    await (await ob.connect(sC).placeLimitOrder(
      pairId,
      Side.BUY,
      P(pxAsk1, priceDecimals),
      A(ethers, sizeSmall, baseDecimals)
    )).wait();

    console.log(`[OK] Seeded pair #${pairId} (${symbol}) @ mark≈${markSafe.toFixed(6)}`);
  }

  console.log("===> Done. Tất cả cặp đã có Orderbook + ít nhất 1 Recent Trade.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
