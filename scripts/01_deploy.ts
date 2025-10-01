// scripts/01_deploy.ts
import { network } from "hardhat";

async function main() {
  const { ethers } = await network.connect();

  const [deployer] = await ethers.getSigners();

  const OracleRouter = await ethers.getContractFactory("OracleRouter");
  const oracle = await OracleRouter.deploy();
  await oracle.waitForDeployment();

  const OnchainOrderBook = await ethers.getContractFactory("OnchainOrderBook");
  const orderbook = await OnchainOrderBook.deploy(await oracle.getAddress());
  await orderbook.waitForDeployment();

  // Mock feeds
  const Mock = await ethers.getContractFactory("MockAggregatorV3");
  const toScaled = (n: number) => BigInt(Math.round(n * 1e8)); // price * 1e8

  const ethFeed = await Mock.deploy(8, toScaled(2600.00));
  const btcFeed = await Mock.deploy(8, toScaled(65000.00));
  const linkFeed = await Mock.deploy(8, toScaled(14.25));
  await Promise.all([ethFeed.waitForDeployment(), btcFeed.waitForDeployment(), linkFeed.waitForDeployment()]);

  await (await oracle.setFeed("ETH - USD", await ethFeed.getAddress())).wait();
  await (await oracle.setFeed("BTC - USD", await btcFeed.getAddress())).wait();
  await (await oracle.setFeed("LINK - USD", await linkFeed.getAddress())).wait();

  const r1 = await (await orderbook.addPair("ETH - USD", 8, 18, 8)).wait();
  const r2 = await (await orderbook.addPair("BTC - USD", 8, 8, 8)).wait();
  const r3 = await (await orderbook.addPair("LINK - USD", 8, 18, 8)).wait();

  const ethPairId = Number(r1!.logs[0].args?.pairId || 1);
  const btcPairId = Number(r2!.logs[0].args?.pairId || 2);
  const linkPairId = Number(r3!.logs[0].args?.pairId || 3);

  console.log("Deployer:", deployer.address);
  console.log("OracleRouter:", await oracle.getAddress());
  console.log("OrderBook:", await orderbook.getAddress());
  console.log("Pairs => ETH:", ethPairId, "BTC:", btcPairId, "LINK:", linkPairId);
  console.log("Feeds =>",
    "ETH:", await ethFeed.getAddress(),
    "BTC:", await btcFeed.getAddress(),
    "LINK:", await linkFeed.getAddress()
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
