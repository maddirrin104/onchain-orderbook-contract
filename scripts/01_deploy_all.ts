import { network } from "hardhat";
import { FEEDS_SEPOLIA } from "../feeds.js";
import { BASE_DEC, baseOf, PRICE_DEC, QUOTE_DEC } from "../decimals.js";

const KIND = process.env.NETWORK_KIND ?? "local"; // "local" | "sepolia"
const P = (x:number) => BigInt(Math.round(x * 1e8)); // priceDecimals=8

async function main() {
  const { ethers } = await network.connect();

  const OracleRouter = await ethers.getContractFactory("OracleRouter");
  const oracle = await OracleRouter.deploy(); await oracle.waitForDeployment();

  const OnchainOrderBook = await ethers.getContractFactory("OnchainOrderBook");
  const ob = await OnchainOrderBook.deploy(await oracle.getAddress()); await ob.waitForDeployment();

  console.log("OracleRouter:", await oracle.getAddress());
  console.log("OrderBook   :", await ob.getAddress());

  const Mock = KIND === "local" ? await ethers.getContractFactory("MockAggregatorV3") : null;

  for (const f of FEEDS_SEPOLIA) {
    const base = baseOf(f.symbol);
    const baseDec = BASE_DEC[base] ?? 18;

    // 1) Đăng ký cặp
    await (await ob.addPair(f.symbol, PRICE_DEC, baseDec, QUOTE_DEC)).wait();

    // 2) Gắn feed
    if (KIND === "local") {
      const initial =
        base==="ETH"?2600 :
        base==="BTC"?65000 :
        base==="LINK"?14.25 :
        base==="XAU"?2400 :
        base==="EUR"?1.07 :
        base==="JPY"?0.0067 :
        (["USDC","DAI","USDE","USDL","PYUSD"].includes(base)?1.0:10.0);
      const mock = await (Mock as any).deploy(8, P(initial));
      await mock.waitForDeployment();
      await (await oracle.setFeed(f.symbol, await mock.getAddress())).wait();
    } else {
      await (await oracle.setFeed(f.symbol, f.address)).wait();
    }
  }

  console.log("All pairs wired for:", KIND);
}
main().catch(e=>{console.error(e);process.exit(1);});
