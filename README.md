# Sample Hardhat 3 Beta Project (`mocha` and `ethers`)

This project showcases a Hardhat 3 Beta project using `mocha` for tests and the `ethers` library for Ethereum interactions.

To learn more about the Hardhat 3 Beta, please visit the [Getting Started guide](https://hardhat.org/docs/getting-started#getting-started-with-hardhat-3). To share your feedback, join our [Hardhat 3 Beta](https://hardhat.org/hardhat3-beta-telegram-group) Telegram group or [open an issue](https://github.com/NomicFoundation/hardhat/issues/new) in our GitHub issue tracker.

## Project Overview

This example project includes:

- A simple Hardhat configuration file.
- Foundry-compatible Solidity unit tests.
- TypeScript integration tests using `mocha` and ethers.js
- Examples demonstrating how to connect to different types of networks, including locally simulating OP mainnet.

## Usage

### Running Tests

To run all the tests in the project, execute the following command:

```shell
npx hardhat test
```

You can also selectively run the Solidity or `mocha` tests:

```shell
npx hardhat test solidity
npx hardhat test mocha
```

### Make a deployment to Sepolia

This project includes an example Ignition module to deploy the contract. You can deploy this module to a locally simulated chain or to Sepolia.

To run the deployment to a local chain:

```shell
npx hardhat ignition deploy ignition/modules/Counter.ts
```

To run the deployment to Sepolia, you need an account with funds to send the transaction. The provided Hardhat configuration includes a Configuration Variable called `SEPOLIA_PRIVATE_KEY`, which you can use to set the private key of the account you want to use.

You can set the `SEPOLIA_PRIVATE_KEY` variable using the `hardhat-keystore` plugin or by setting it as an environment variable.

To set the `SEPOLIA_PRIVATE_KEY` config variable using `hardhat-keystore`:

```shell
npx hardhat keystore set SEPOLIA_PRIVATE_KEY
```

After setting the variable, you can run the deployment with the Sepolia network:

```shell
npx hardhat ignition deploy --network sepolia ignition/modules/Counter.ts
```


# 1) Node local
```bash
npx hardhat node
```

# 2) Deploy tất cả cặp + mock oracle price
> $env:NETWORK_KIND="local"
```bash
npx hardhat run scripts/01_deploy_all.ts --network localhost
```
 lưu lại địa chỉ OrderBook in ra

# 3) Seed toàn bộ cặp
> $env:OB_ADDR="0x...OrderBookAddressFromDeploy"
```bash
npx hardhat run scripts/02_seed_all.ts --network localhost
npx hardhat run scripts/03_seed_all.ts --network localhost
```
# 4) Measure gas
```bash
npx hardhat run scripts/04_measure_gas.ts --network localhost
```
# 5)Scalability
```bash
npx hardhat run scripts/05_scalability_depth.ts --network localhost
```

# Repo tham khảo
https://github.com/cjxe/on-chain-dex?tab=readme-ov-file
https://github.com/hord/hord-orderbook-dex-contracts
