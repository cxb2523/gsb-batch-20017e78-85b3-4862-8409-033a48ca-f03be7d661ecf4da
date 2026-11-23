module.exports = {
    testEnvironment: 'jsdom',
    roots: [ '<rootDir>/test' ],
    moduleNameMapper: {
        '^@events/(.*)$': '<rootDir>/src/events/$1',
        '^@client/(.*)$': '<rootDir>/src/client/$1',
        '^@server/(.*)$': '<rootDir>/src/server/$1',
        '^@css/(.*)$': '<rootDir>/assets/css/$1',
    },
    clearMocks: true,
};
