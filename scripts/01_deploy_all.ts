import { network } from "hardhat";
import { FEEDS_SEPOLIA } from "../feeds.js";
import { BASE_DEC, baseOf, PRICE_DEC, QUOTE_DEC } from "../decimals.js";

const KIND = process.env.NETWORK_KIND ?? "local";

async function main() {
  const { ethers } = await network.connect();

  const [deployer] = await ethers.getSigners();

  const OracleRouter = await ethers.getContractFactory("OracleRouter");
  const oracle = await OracleRouter.deploy();
  await oracle.waitForDeployment();

  const OnchainOrderBook = await ethers.getContractFactory("OnchainOrderBook");
  const ob = await OnchainOrderBook.deploy(await oracle.getAddress());
  await ob.waitForDeployment();

  console.log("Deployer    :", deployer.address);
  console.log("OracleRouter:", await oracle.getAddress());
  console.log("OrderBook   :", await ob.getAddress());

  // Mock price feed (đã có)
  const MockAgg = KIND === "local"
    ? await ethers.getContractFactory("MockAggregatorV3")
    : null;

  // Mock ERC20 cho test
  const MockERC20 = await ethers.getContractFactory("MockERC20");

  // Quote token chung cho tất cả pair, ví dụ "USD Stable"
  const quoteToken = await MockERC20.deploy("Mock USD", "mUSD", QUOTE_DEC);
  await quoteToken.waitForDeployment();
  console.log("Quote token :", await quoteToken.getAddress());

  for (const f of FEEDS_SEPOLIA) {
    const base = baseOf(f.symbol);             // ví dụ "ETH", "BTC"
    const baseDec = BASE_DEC[base] ?? 18;

    // 1) Deploy base token riêng cho từng base symbol (cho đẹp; hoặc tái dùng 1 token cũng được)
    const baseToken = await MockERC20.deploy(`Mock ${base}`, `m${base}`, baseDec);
    await baseToken.waitForDeployment();

    const baseAddr = await baseToken.getAddress();
    const quoteAddr = await quoteToken.getAddress();

    console.log(`Pair ${f.symbol}: base=${baseAddr}, quote=${quoteAddr}`);

    // 2) Đăng ký cặp (chú ý add thêm baseToken, quoteToken)
    await (
      await (ob as any).addPair(
        f.symbol,
        PRICE_DEC,
        baseDec,
        QUOTE_DEC,
        baseAddr,
        quoteAddr,
      )
    ).wait();


    // 3) Gắn oracle feed
    if (KIND === "local") {
      const P = (x: number) => BigInt(Math.round(x * 1e8)); // vẫn priceDecimals=8

      const initial =
        base === "ETH" ? 2600 :
        base === "BTC" ? 65000 :
        base === "LINK" ? 14.25 :
        base === "XAU" ? 2400 :
        base === "EUR" ? 1.07 :
        base === "JPY" ? 0.0067 :
        (["USDC","DAI","USDE","USDL","PYUSD"].includes(base) ? 1.0 : 10.0);

      const mock = await (MockAgg as any).deploy(8, P(initial));
      await mock.waitForDeployment();
      await (await oracle.setFeed(f.symbol, await mock.getAddress())).wait();
    } else {
      await (await oracle.setFeed(f.symbol, f.address)).wait();
    }
  }

  console.log("All pairs wired for:", KIND);
}
main().catch(e => { console.error(e); process.exit(1); });
