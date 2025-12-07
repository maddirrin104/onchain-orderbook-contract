// scripts/05_scalability_depth.ts
import { network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

enum Side {
  BUY,
  SELL,
}

const P = (x: number, priceDec = 8) => {
  const mul = 10 ** priceDec;
  return BigInt(Math.round(x * mul));
};

async function logGas(label: string, txPromise: Promise<any>) {
  const tx = await txPromise;
  const rc = await tx.wait();
  console.log(`${label} gasUsed = ${rc.gasUsed.toString()}`);
  return rc;
}

/** Đường dẫn file log */
const LOG_DIR = path.join("logs");
const LOG_FILE = path.join(LOG_DIR, "depth_gas.log");

async function measureAtDepth(depth: number) {
  const { ethers } = await network.connect();
  const [deployer, maker, taker] = await ethers.getSigners();

  console.log(`\n========== DEPTH = ${depth} orders ==========`);

  // ==== Deploy fresh contracts cho mỗi depth ====
  const OracleRouter = await ethers.getContractFactory("OracleRouter");
  const oracle = await OracleRouter.deploy(deployer.address);
  await oracle.waitForDeployment();

  const OnchainOrderBook = await ethers.getContractFactory("OnchainOrderBook");
  const ob = await OnchainOrderBook.deploy(await oracle.getAddress());
  await ob.waitForDeployment();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const baseToken = await MockERC20.deploy("Mock BASE", "mBASE", 18);
  await baseToken.waitForDeployment();
  const quoteToken = await MockERC20.deploy("Mock USD", "mUSD", 18);
  await quoteToken.waitForDeployment();

  const obAddr = await ob.getAddress();
  const baseAddr = await baseToken.getAddress();
  const quoteAddr = await quoteToken.getAddress();

  const PRICE_DEC = 8;
  const BASE_DEC = 18;
  const QUOTE_DEC = 18;

  // addPair
  await logGas(
    `addPair (depth=${depth})`,
    ob.addPair("BASE/USD", PRICE_DEC, BASE_DEC, QUOTE_DEC, baseAddr, quoteAddr)
  );

  const pairId = 1n;

  const A = (x: number, dec: number) => ethers.parseUnits(x.toString(), dec);
  const BASE_MINT = A(1_000_000, BASE_DEC);
  const QUOTE_MINT = A(1_000_000, QUOTE_DEC);

  const MAX = ethers.MaxUint256;

  // Mint + approve rộng rãi
  await (await baseToken.mint(maker.address, BASE_MINT)).wait();
  await (await quoteToken.mint(maker.address, QUOTE_MINT)).wait();
  await (await baseToken.mint(taker.address, BASE_MINT)).wait();
  await (await quoteToken.mint(taker.address, QUOTE_MINT)).wait();

  await (await baseToken.connect(maker).approve(obAddr, MAX)).wait();
  await (await quoteToken.connect(maker).approve(obAddr, MAX)).wait();
  await (await baseToken.connect(taker).approve(obAddr, MAX)).wait();
  await (await quoteToken.connect(taker).approve(obAddr, MAX)).wait();

  // ==== Seed orderbook với N lệnh SELL ====
  const BASE_PRICE_NEAR = 1000;
  const BASE_PRICE_FAR = 2000;

  const SELL_SIZE_PER_ORDER = A(1, BASE_DEC); // 1 BASE mỗi lệnh

  // Deposit base đủ cho N lệnh
  const totalBaseNeeded = SELL_SIZE_PER_ORDER * BigInt(depth);
  await (await ob.connect(maker).depositBase(pairId, totalBaseNeeded)).wait();

  for (let i = 0; i < depth; i++) {
    let priceNum: number;
    if (i < 3) {
      // 3 level gần: 1000, 1010, 1020
      priceNum = BASE_PRICE_NEAR + i * 10;
    } else {
      // phần còn lại xa: 2000, 2010, 2020, ...
      priceNum = BASE_PRICE_FAR + (i - 3) * 10;
    }
    const price = P(priceNum, PRICE_DEC);

    await ob
      .connect(maker)
      .placeLimitOrder(pairId, Side.SELL, price, SELL_SIZE_PER_ORDER);
  }

  // ==== Taker BUY market-style: khớp đúng 3 price-level gần ====
  const BUY_PRICE = P(1200, PRICE_DEC);
  const BUY_AMOUNT = A(3, BASE_DEC); // 3 BASE

  await (
    await ob.connect(taker).depositQuote(pairId, A(100_000, QUOTE_DEC))
  ).wait();

  const rc = await logGas(
    `placeLimit BUY (market-like) at depth=${depth}`,
    ob.connect(taker).placeLimitOrder(pairId, Side.BUY, BUY_PRICE, BUY_AMOUNT)
  );

  // Ghi JSON line vào file log
  const lineObj = {
    depth,
    gas_placeLimitBuy_market_like: rc.gasUsed.toString(),
  };
  const line = JSON.stringify(lineObj);
  console.log(line); // vẫn in ra console cho dễ nhìn
  fs.appendFileSync(LOG_FILE, line + "\n", { encoding: "utf8" });
}

async function main() {
  // Tạo thư mục logs + clear file cũ
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
  fs.writeFileSync(LOG_FILE, "", { encoding: "utf8" }); // clear file

  const depths = [10, 100, 500, 1000];

  for (const d of depths) {
    await measureAtDepth(d);
  }

  console.log(`\n===> DONE Scalability experiment. Log saved at ${LOG_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
