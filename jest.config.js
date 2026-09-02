module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // TON tests only. The EVM package uses hardhat/mocha and the BTC package
  // uses mocha; each has its own `npm test`.
  roots: ['<rootDir>/tests'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/evm/', '/btc/'],
  testTimeout: 60000,
};
