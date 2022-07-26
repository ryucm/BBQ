const shellArgs = process.argv.slice(2);
const path = shellArgs.shift();
const crawler = require(`./src/${path}`).default;
(async () => await crawler.crawl())();