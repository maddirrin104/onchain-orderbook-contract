// scripts/02_seed.ts
import { network } from "hardhat";
enum Side { BUY, SELL }

async function main() {
  const { ethers } = await network.connect();

  const obAddr = process.env.OB_ADDR!;
  const ob = await ethers.getContractAt("OnchainOrderBook", obAddr) as any; // Use 'as any' to bypass type error, or import the correct contract type if available

  const ETH = Number(process.env.ETH_PAIR_ID || 1);
  const BTC = Number(process.env.BTC_PAIR_ID || 2);
  const LINK = Number(process.env.LINK_PAIR_ID || 3);

  const [a, b, c] = await ethers.getSigners();
  const P = (x: number) => BigInt(Math.round(x * 1e8));
  const A18 = (x: number) => ethers.parseUnits(x.toString(), 18);
  const A8  = (x: number) => ethers.parseUnits(x.toString(), 8);

  await (await ob.connect(a).placeLimitOrder(ETH, Side.BUY,  P(2599.50), A18(0.7))).wait();
  await (await ob.connect(b).placeLimitOrder(ETH, Side.BUY,  P(2598.00), A18(1.2))).wait();
  await (await ob.connect(c).placeLimitOrder(ETH, Side.SELL, P(2601.00), A18(0.6))).wait();
  await (await ob.connect(b).placeLimitOrder(ETH, Side.BUY,  P(2601.00), A18(0.5))).wait(); // cross

  await (await ob.connect(a).placeLimitOrder(BTC, Side.BUY,  P(64950.00), A8(0.01))).wait();
  await (await ob.connect(b).placeLimitOrder(BTC, Side.SELL, P(64960.00), A8(0.02))).wait();
  await (await ob.connect(c).placeLimitOrder(BTC, Side.BUY,  P(64960.00), A8(0.02))).wait(); // cross

  await (await ob.connect(a).placeLimitOrder(LINK, Side.SELL, P(14.30), A18(50))).wait();
  await (await ob.connect(b).placeLimitOrder(LINK, Side.BUY,  P(14.30), A18(10))).wait();    // partial fill

  console.log("Seed done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
