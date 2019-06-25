#!/usr/bin/env node

let argv = require('yargs')
  .command('$0 [directory]', 'scrape arbital.com', yargs=>
    yargs.positional('directory', {
           desc: 'destination directory',
           string: true,
           default: 'arbital.com' })
         .option('url', {
           desc: 'arbital url',
           default: 'https://arbital.com' }))
  .help()
  .argv

console.log('argv', argv)
