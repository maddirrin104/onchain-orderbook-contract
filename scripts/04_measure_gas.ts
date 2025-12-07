// scripts/04_measure_gas.ts
import { network } from "hardhat";

enum Side {
  BUY,
  SELL,
}

// helper log gas
async function logGas(label: string, txPromise: Promise<any>) {
  const tx = await txPromise;
  const rc = await tx.wait();
  console.log(`${label} gasUsed = ${rc.gasUsed.toString()}`);
  return rc;
}

// scale helpers
const P = (x: number, priceDec = 8) => {
  const mul = 10 ** priceDec;
  return BigInt(Math.round(x * mul));
};

async function main() {
  const { ethers } = await network.connect();
  const [deployer, maker, taker] = await ethers.getSigners();

  console.log("Deployer:", deployer.address);
  console.log("Maker   :", maker.address);
  console.log("Taker   :", taker.address);

  /* ========== 1. Deploy contracts ========== */

  const OracleRouter = await ethers.getContractFactory("OracleRouter");
  // OracleRouter(constructor(address initialOwner))
  const oracle = await OracleRouter.deploy(deployer.address);
  await oracle.waitForDeployment();

  const OnchainOrderBook = await ethers.getContractFactory("OnchainOrderBook");
  const ob = await OnchainOrderBook.deploy(await oracle.getAddress());
  await ob.waitForDeployment();

  const MockERC20 = await ethers.getContractFactory("MockERC20");

  console.log("OracleRouter:", await oracle.getAddress());
  console.log("OrderBook   :", await ob.getAddress());

  // base = token tài sản, quote = stable
  const baseToken = await MockERC20.deploy("Mock BASE", "mBASE", 18);
  await baseToken.waitForDeployment();
  const quoteToken = await MockERC20.deploy("Mock USD", "mUSD", 18);
  await quoteToken.waitForDeployment();

  const baseAddr = await baseToken.getAddress();
  const quoteAddr = await quoteToken.getAddress();

  console.log("Base token :", baseAddr);
  console.log("Quote token:", quoteAddr);

  /* ========== 2. AddPair ========== */

  const PRICE_DEC = 8;
  const BASE_DEC = 18;
  const QUOTE_DEC = 18;

  await logGas(
    "addPair",
    ob.addPair("BASE/USD", PRICE_DEC, BASE_DEC, QUOTE_DEC, baseAddr, quoteAddr)
  );

  const pairId = 1n;

  /* ========== 3. Mint + approve cho maker/taker ========== */

  const A = (x: number, dec: number) => ethers.parseUnits(x.toString(), dec);

    // ĐỔI từ 10_000 thành 100_000 cho rộng rãi
    const BASE_MINT = A(100_000, BASE_DEC);
    const QUOTE_MINT = A(100_000, QUOTE_DEC);

  const obAddr = await ob.getAddress();
  const MAX = ethers.MaxUint256;

  // maker
  await (await baseToken.mint(maker.address, BASE_MINT)).wait();
  await (await quoteToken.mint(maker.address, QUOTE_MINT)).wait();
  await (await baseToken.connect(maker).approve(obAddr, MAX)).wait();
  await (await quoteToken.connect(maker).approve(obAddr, MAX)).wait();

  // taker
  await (await baseToken.mint(taker.address, BASE_MINT)).wait();
  await (await quoteToken.mint(taker.address, QUOTE_MINT)).wait();
  await (await baseToken.connect(taker).approve(obAddr, MAX)).wait();
  await (await quoteToken.connect(taker).approve(obAddr, MAX)).wait();

  console.log("== SCENARIO 1: Deposit / Withdraw ==");

  /* ========== SCENARIO 1: Deposit / Withdraw ========== */

  const DEP_BASE = A(1_000, BASE_DEC);
  const DEP_QUOTE = A(1_000, QUOTE_DEC);

  await logGas(
    "depositBase (maker)",
    ob.connect(maker).depositBase(pairId, DEP_BASE)
  );
  await logGas(
    "depositQuote (maker)",
    ob.connect(maker).depositQuote(pairId, DEP_QUOTE)
  );

  await logGas(
    "withdrawBase (maker)",
    ob.connect(maker).withdrawBase(pairId, A(100, BASE_DEC))
  );
  await logGas(
    "withdrawQuote (maker)",
    ob.connect(maker).withdrawQuote(pairId, A(100, QUOTE_DEC))
  );

  console.log("== SCENARIO 2: SELL resting (no match) + cancel ==");

  /* ========== SCENARIO 2: Limit SELL KHÔNG khớp (resting ask) + cancel ========== */

  const PRICE_LIMIT_SELL = P(2_000, PRICE_DEC); // 2000 USD
  const AMOUNT_LIMIT_SELL = A(5, BASE_DEC); // 5 BASE

  // đảm bảo maker có đủ base trong vault cho SELL
  await (await ob.connect(maker).depositBase(pairId, AMOUNT_LIMIT_SELL)).wait();

  const txLimitNoMatch = await ob
    .connect(maker)
    .placeLimitOrder(pairId, Side.SELL, PRICE_LIMIT_SELL, AMOUNT_LIMIT_SELL);
  const rcLimitNoMatch = await txLimitNoMatch.wait();
  if (rcLimitNoMatch) {
    console.log(
      "placeLimit SELL (no match, resting ask) gasUsed =",
      rcLimitNoMatch.gasUsed.toString()
    );
  } else {
    console.log("placeLimit SELL (no match, resting ask) receipt = null");
  }

  const limitOrderId = (await ob.nextOrderId()) - 1n; // orderId vừa tạo

  await logGas(
    "cancelOrder (resting ask)",
    ob.connect(maker).cancelOrder(pairId, limitOrderId)
  );

  console.log("== SCENARIO 3: BUY acting as market (single fill) ==");

  /* ========== SCENARIO 3: BUY acting as market, khớp 1 lệnh ========== */

  // 3.1: Maker tạo 1 lệnh SELL resting ở giá 1000
  const PRICE_SELL = P(1_000, PRICE_DEC);
  const AMOUNT_SELL = A(3, BASE_DEC); // 3 BASE

  await (await ob.connect(maker).depositBase(pairId, AMOUNT_SELL)).wait();

  const txSellResting = await ob
    .connect(maker)
    .placeLimitOrder(pairId, Side.SELL, PRICE_SELL, AMOUNT_SELL);
  const rcSellResting = await txSellResting.wait();
  if (rcSellResting) {
    console.log(
      "placeLimit SELL (resting, 1 level) gasUsed =",
      rcSellResting.gasUsed.toString()
    );
  } else {
    console.log("placeLimit SELL (resting, 1 level) receipt = null");
  }

  // 3.2: Taker deposit quote để BUY
  const QUOTE_FOR_MARKET = A(10_000, QUOTE_DEC);
  await (await ob.connect(taker).depositQuote(pairId, QUOTE_FOR_MARKET)).wait();

  // 3.3: Taker BUY với giá 1200 > 1000 → khớp full 3 BASE
  const PRICE_BUY_MARKET = P(1_200, PRICE_DEC);
  const AMOUNT_BUY_MARKET = AMOUNT_SELL; // 3 BASE

  await logGas(
    "placeLimit BUY (market-like, 1 fill)",
    ob
      .connect(taker)
      .placeLimitOrder(pairId, Side.BUY, PRICE_BUY_MARKET, AMOUNT_BUY_MARKET)
  );

  console.log("== SCENARIO 4: BUY không khớp (resting bid) ==");

  /* ========== SCENARIO 4: BUY KHÔNG khớp (resting bid) ========== */

  // giả sử book đang trống phía ask (sau scenario 3 đã fill hết),
  // nên BUY dưới đây sẽ không khớp và trở thành resting bid.
  const PRICE_BID_REST = P(800, PRICE_DEC); // 800 USD
  const AMOUNT_BID_REST = A(4, BASE_DEC); // 4 BASE

  // đảm bảo maker có đủ quote trong vault
  await (await ob.connect(maker).depositQuote(pairId, A(5_000, QUOTE_DEC))).wait();

  await logGas(
    "placeLimit BUY (no match, resting bid)",
    ob
      .connect(maker)
      .placeLimitOrder(pairId, Side.BUY, PRICE_BID_REST, AMOUNT_BID_REST)
  );

  console.log("== SCENARIO 5: Taker BUY khớp NHIỀU mức giá (multi-fill) ==");

  /* ========== SCENARIO 5: Taker BUY khớp N mức giá (multi-fill) ========== */

  // Tạo 3 lệnh SELL resting ở các price level khác nhau: 1100, 1200, 1300
  const SELL_PX_1 = P(1_100, PRICE_DEC);
  const SELL_PX_2 = P(1_200, PRICE_DEC);
  const SELL_PX_3 = P(1_300, PRICE_DEC);

  const SELL_AMT_1 = A(1, BASE_DEC);
  const SELL_AMT_2 = A(2, BASE_DEC);
  const SELL_AMT_3 = A(3, BASE_DEC);
  const TOTAL_SELL_AMT = SELL_AMT_1 + SELL_AMT_2 + SELL_AMT_3; // 6 BASE

  // deposit đủ base cho maker
  await (await ob.connect(maker).depositBase(pairId, TOTAL_SELL_AMT)).wait();

  await logGas(
    "placeLimit SELL@1100 (resting)",
    ob.connect(maker).placeLimitOrder(pairId, Side.SELL, SELL_PX_1, SELL_AMT_1)
  );
  await logGas(
    "placeLimit SELL@1200 (resting)",
    ob.connect(maker).placeLimitOrder(pairId, Side.SELL, SELL_PX_2, SELL_AMT_2)
  );
  await logGas(
    "placeLimit SELL@1300 (resting)",
    ob.connect(maker).placeLimitOrder(pairId, Side.SELL, SELL_PX_3, SELL_AMT_3)
  );

  // Taker deposit thêm quote để BUY multi-fill
  await (
    await ob.connect(taker).depositQuote(pairId, A(20_000, QUOTE_DEC))
  ).wait();

  // BUY với giá 1400 > tất cả 1100 / 1200 / 1300, size = 6 BASE → khớp 3 mức giá
  const PRICE_BUY_MULTI = P(1_400, PRICE_DEC);
  const AMOUNT_BUY_MULTI = TOTAL_SELL_AMT; // 6 BASE

  await logGas(
    "placeLimit BUY (multi-fill 3 levels)",
    ob
      .connect(taker)
      .placeLimitOrder(pairId, Side.BUY, PRICE_BUY_MULTI, AMOUNT_BUY_MULTI)
  );

  console.log("== SCENARIO 6: Taker BUY partial fill rồi REST phần còn lại ==");

  /* ========== SCENARIO 6: Taker BUY partial + rest ========== */

  // Setup: 2 lệnh SELL tổng 3 BASE, BUY size 5 BASE → fill 3, còn 2 rest ở bid side.

  const SELL2_PX_1 = P(1_500, PRICE_DEC);
  const SELL2_PX_2 = P(1_600, PRICE_DEC);

  const SELL2_AMT_1 = A(1, BASE_DEC);
  const SELL2_AMT_2 = A(2, BASE_DEC);
  const TOTAL_SELL2 = SELL2_AMT_1 + SELL2_AMT_2; // 3 BASE

  // deposit base
  await (await ob.connect(maker).depositBase(pairId, TOTAL_SELL2)).wait();

  await logGas(
    "placeLimit SELL@1500 (resting)",
    ob
      .connect(maker)
      .placeLimitOrder(pairId, Side.SELL, SELL2_PX_1, SELL2_AMT_1)
  );
  await logGas(
    "placeLimit SELL@1600 (resting)",
    ob
      .connect(maker)
      .placeLimitOrder(pairId, Side.SELL, SELL2_PX_2, SELL2_AMT_2)
  );

  // Taker BUY với size 5 BASE, price = 1600:
  //  - khớp toàn bộ 3 BASE phía ask
  //  - 2 BASE còn lại rest thành bid @ 1600
  await (
    await ob.connect(taker).depositQuote(pairId, A(20_000, QUOTE_DEC))
  ).wait();

  const PRICE_BUY_PARTIAL = P(1_600, PRICE_DEC);
  const AMOUNT_BUY_PARTIAL = A(5, BASE_DEC); // 5 BASE

  await logGas(
    "placeLimit BUY (partial fill, rest bid)",
    ob
      .connect(taker)
      .placeLimitOrder(pairId, Side.BUY, PRICE_BUY_PARTIAL, AMOUNT_BUY_PARTIAL)
  );

  console.log("===> DONE. Copy tất cả gasUsed phía trên vào bảng thống kê.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
