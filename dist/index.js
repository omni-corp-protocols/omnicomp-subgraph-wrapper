"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const express_ws_1 = __importDefault(require("express-ws"));
const body_parser_1 = __importDefault(require("body-parser"));
const winston_1 = __importDefault(require("winston"));
const express_winston_1 = __importDefault(require("express-winston"));
const http_1 = __importDefault(require("http"));
const ws_1 = __importDefault(require("ws"));
const bignumber_js_1 = __importDefault(require("bignumber.js"));
const subscriptions_transport_ws_1 = require("subscriptions-transport-ws");
const apollo_server_express_1 = require("apollo-server-express");
const apollo_link_1 = require("apollo-link");
const apollo_link_http_1 = require("apollo-link-http");
const apollo_link_ws_1 = require("apollo-link-ws");
const apollo_env_1 = require("apollo-env");
const apollo_utilities_1 = require("apollo-utilities");
const graphql_tools_1 = require("graphql-tools");
/**
 * Logging
 */
let loggerColorizer = winston_1.default.format.colorize();
let loggerTransport = new winston_1.default.transports.Console({
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), loggerColorizer, winston_1.default.format.ms(), winston_1.default.format.printf(args => {
        let { level, message, component, timestamp, ms } = args;
        return `${timestamp} ${level} ${component} → ${message} ${loggerColorizer.colorize('debug', ms)}`;
    })),
});
let logger = winston_1.default
    .createLogger({
    level: 'debug',
    transports: [loggerTransport],
})
    .child({ component: 'App' });
/**
 * GraphQL schema
 */
const SUBGRAPH_QUERY_ENDPOINT = "https://api.thegraph.com/subgraphs/name/omni-corp-protocols/omnicomp";
const SUBGRAPH_SUBSCRIPTION_ENDPOINT = "wss://api.thegraph.com/subgraphs/name/omni-corp-protocols/omnicomp";
if (!SUBGRAPH_QUERY_ENDPOINT) {
    throw new Error('Environment variable SUBGRAPH_QUERY_ENDPOINT is not set');
}
if (!SUBGRAPH_SUBSCRIPTION_ENDPOINT) {
    throw new Error('Environment variable SUBGRAPH_SUBSCRIPTION_ENDPOINT is not set');
}
const createQueryNodeHttpLink = () => new apollo_link_http_1.HttpLink({
    uri: SUBGRAPH_QUERY_ENDPOINT,
    fetch: apollo_env_1.fetch,
});
const createSchema = () => __awaiter(void 0, void 0, void 0, function* () {
    let httpLink = createQueryNodeHttpLink();
    let remoteSchema = yield graphql_tools_1.introspectSchema(httpLink);
    const subscriptionClient = new subscriptions_transport_ws_1.SubscriptionClient(SUBGRAPH_SUBSCRIPTION_ENDPOINT, {
        reconnect: true,
    }, ws_1.default);
    const wsLink = new apollo_link_ws_1.WebSocketLink(subscriptionClient);
    const link = apollo_link_1.split(({ query }) => {
        const { kind, operation } = apollo_utilities_1.getMainDefinition(query);
        return kind === 'OperationDefinition' && operation === 'subscription';
    }, wsLink, httpLink);
    let subgraphSchema = graphql_tools_1.makeRemoteExecutableSchema({
        schema: remoteSchema,
        link,
    });
    let customSchema = `
    extend type Account {
      health: BigDecimal
      totalBorrowValueInEth: BigDecimal!
      totalCollateralValueInEth: BigDecimal!
    }

    extend type AccountCToken {
      supplyBalanceUnderlying: BigDecimal!
      lifetimeSupplyInterestAccrued: BigDecimal!
      borrowBalanceUnderlying: BigDecimal!
      lifetimeBorrowInterestAccrued: BigDecimal!
    }
  `;
    const bignum = (value) => new bignumber_js_1.default(value);
    const supplyBalanceUnderlying = (cToken) => bignum(cToken.cTokenBalance).times(cToken.market.exchangeRate);
    const borrowBalanceUnderlying = (cToken) => bignum(cToken.accountBorrowIndex).eq(bignum('0'))
        ? bignum('0')
        : bignum(cToken.storedBorrowBalance)
            .times(cToken.market.borrowIndex)
            .dividedBy(cToken.accountBorrowIndex);
    const tokenInEth = (market) => bignum(market.collateralFactor)
        .times(market.exchangeRate)
        .times(market.underlyingPrice);
    const totalCollateralValueInEth = (account) => account.___tokens.reduce((acc, token) => acc.plus(tokenInEth(token.market).times(token.cTokenBalance)), bignum('0'));
    const totalBorrowValueInEth = (account) => !account.hasBorrowed
        ? bignum('0')
        : account.___tokens.reduce((acc, token) => acc.plus(bignum(token.market.underlyingPrice).times(borrowBalanceUnderlying(token))), bignum('0'));
    return graphql_tools_1.mergeSchemas({
        schemas: [subgraphSchema, customSchema],
        resolvers: {
            Account: {
                health: {
                    fragment: `
            ... on Account {
              id
              hasBorrowed
              ___tokens: tokens {
                cTokenBalance
                storedBorrowBalance
                accountBorrowIndex
                market {
                  borrowIndex
                  collateralFactor
                  exchangeRate
                  underlyingPrice
                }
              }
            }
          `,
                    resolve: (account, _args, _context, _info) => {
                        if (!account.hasBorrowed) {
                            return null;
                        }
                        else {
                            let totalBorrow = totalBorrowValueInEth(account);
                            return totalBorrow.eq('0')
                                ? totalCollateralValueInEth(account)
                                : totalCollateralValueInEth(account).dividedBy(totalBorrow);
                        }
                    },
                },
                totalBorrowValueInEth: {
                    fragment: `
            ... on Account {
              id
              hasBorrowed
              ___tokens: tokens {
                cTokenBalance
                storedBorrowBalance
                accountBorrowIndex
                market {
                  borrowIndex
                  collateralFactor
                  exchangeRate
                  underlyingPrice
                }
              }
            }
          `,
                    resolve: (account, _args, _context, _info) => totalBorrowValueInEth(account),
                },
                totalCollateralValueInEth: {
                    fragment: `
            ... on Account {
              id
              ___tokens: tokens {
                cTokenBalance
                market {
                  collateralFactor
                  exchangeRate
                  underlyingPrice
                }
              }
            }
          `,
                    resolve: (account, _args, _context, _info) => totalCollateralValueInEth(account),
                },
            },
            AccountCToken: {
                supplyBalanceUnderlying: {
                    fragment: `... on AccountCToken { id cTokenBalance market { exchangeRate } }`,
                    resolve: (cToken, _args, _context, _info) => supplyBalanceUnderlying(cToken),
                },
                lifetimeSupplyInterestAccrued: {
                    fragment: `
            ... on AccountCToken {
              id
              cTokenBalance
              market { exchangeRate }
              totalUnderlyingSupplied
              totalUnderlyingRedeemed
            }
          `,
                    resolve: (cToken, _args, _context, _info) => supplyBalanceUnderlying(cToken)
                        .minus(cToken.totalUnderlyingSupplied)
                        .plus(cToken.totalUnderlyingRedeemed),
                },
                borrowBalanceUnderlying: {
                    fragment: `
            ... on AccountCToken {
              id
              storedBorrowBalance
              accountBorrowIndex
              market { borrowIndex }
            }
          `,
                    resolve: (cToken, _args, _context, _info) => borrowBalanceUnderlying(cToken),
                },
                lifetimeBorrowInterestAccrued: {
                    fragment: `
            ... on AccountCToken {
              id
              storedBorrowBalance
              accountBorrowIndex
              market { borrowIndex }
              totalUnderlyingBorrowed
              totalUnderlyingRepaid
            }
          `,
                    resolve: (cToken, _args, _context, _info) => borrowBalanceUnderlying(cToken)
                        .minus(cToken.totalUnderlyingBorrowed)
                        .plus(cToken.totalUnderlyingRepaid),
                },
            },
        },
    });
});
/**
 * Server application
 */
// Define the middleware
const rejectBadHeaders = (req, res, next) => __awaiter(void 0, void 0, void 0, function* () {
    if (req.headers['challenge-bypass-token'] ||
        req.headers['x_proxy_id']
    // Note: This one doesn't work on Google Cloud:
    // req.headers["via"]
    ) {
        return res.status(400).send('Bad Request');
    }
    else {
        next();
    }
});
const run = () => __awaiter(void 0, void 0, void 0, function* () {
    logger.info(`Create application`);
    const { app } = express_ws_1.default(express_1.default());
    app.use(rejectBadHeaders);
    app.use(body_parser_1.default.json());
    app.use(body_parser_1.default.urlencoded({ extended: true }));
    app.use(express_winston_1.default.logger({
        level: 'debug',
        transports: [loggerTransport],
        baseMeta: { component: 'Server' },
    }));
    app.use(express_winston_1.default.errorLogger({
        transports: [loggerTransport],
        baseMeta: { component: 'Server' },
    }));
    logger.info(`Create Apollo server`);
    const apolloServer = new apollo_server_express_1.ApolloServer({
        subscriptions: {
            path: '/',
        },
        schema: yield createSchema(),
        introspection: true,
        playground: true,
        context: ({ req }) => __awaiter(void 0, void 0, void 0, function* () {
            return {
                logger: logger.child({ component: 'ApolloServer' }),
            };
        }),
    });
    logger.info(`Install GraphQL request handlers`);
    apolloServer.applyMiddleware({
        app,
        path: '/',
        cors: {
            origin: '*',
        },
    });
    logger.info(`Create HTTP server`);
    const server = http_1.default.createServer(app);
    logger.info(`Install GraphQL subscription handlers`);
    apolloServer.installSubscriptionHandlers(server);
    logger.info(`Start server`);
    try {
        yield server.listen(9500, () => {
            logger.info('Listening on port 9500');
        });
    }
    catch (e) {
        logger.error(`Server crashed:`, e);
        process.exitCode = 1;
    }
});
run();
//# sourceMappingURL=index.js.map