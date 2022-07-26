import * as yargs from 'yargs';

const argv =  yargs.argv;

const shellArgs = argv._;
const path = shellArgs.shift();
const crawler = require(`./src/${path}/index.js`).default;
(async () => await crawler.crawl())();