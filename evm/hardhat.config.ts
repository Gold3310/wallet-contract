import { HardhatUserConfig, subtask } from 'hardhat/config';
import { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } from 'hardhat/builtin-tasks/task-names';
import '@nomicfoundation/hardhat-ethers';
import '@nomicfoundation/hardhat-chai-matchers';

// This sandbox cannot reach binaries.soliditylang.org, so use the solc build
// that ships as a JS module on npm instead of letting Hardhat download one.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args: any, hre, runSuper) => {
  if (args.solcVersion === '0.8.24') {
    return {
      compilerPath: require.resolve('solc/soljson.js'),
      isSolcJs: true,
      version: args.solcVersion,
      longVersion: '0.8.24+commit.e11b9ed9',
    };
  }
  return runSuper();
});

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun', // OpenZeppelin 5.6 uses mcopy
    },
  },
  networks: {
    hardhat: {},
    sepolia: {
      url: process.env.RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com',
      accounts: process.env.OWNER_PRIVATE_KEY ? [process.env.OWNER_PRIVATE_KEY] : [],
    },
  },
  paths: { tests: './test' },
};
export default config;
