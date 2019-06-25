#!/usr/bin/env node
let fs = require('fs-extra')
let request = require('request-promise-native')
let sanitizeFilename = require('sanitize-filename')

let argv = require('yargs')
  .command('$0 [directory]', 'scrape arbital.com', yargs=>
    yargs.positional('directory', {
           desc: 'destination directory',
           string: true,
           default: 'arbital.com' })
         .option('url', {
           desc: 'arbital url',
           default: 'https://arbital.com' })
         .option('page', {
           desc: 'pages to download or start at',
           array: true,
           string: true,
           default: ['arbital_front_page'] }))
  .help()
  .argv

let requestRawPage = async aliasOrId=>{
  let url = `${argv.url}/json/primaryPage/`
  let body = { pageAlias: aliasOrId }
  console.log('fetching', aliasOrId, 'POST', url, body)
  return await request({
    method: 'POST',
    url: url,
    json: true,
    body: body })
}

let findPageInRawPageJson = (aliasOrId, rawPageJson)=> rawPageJson.pages[aliasOrId] || Object.values(rawPageJson.pages).find(p=>p.alias==aliasOrId)

;(async ()=>{
  await fs.mkdirp(argv.directory)

  let toDownload = Array.from(argv.page)
  while (toDownload.length > 0) {
    let aliasOrId = toDownload.pop()
    let rawPage = await requestRawPage(aliasOrId)
    let page = findPageInRawPageJson(aliasOrId, rawPage)
    aliasOrId = page.alias || page.pageId

    let file = `${argv.directory}/raw/${sanitizeFilename(page.pageId)}.json`
    console.log('writing', aliasOrId, file)
    await fs.mkdirp(`${argv.directory}/raw`)
    await fs.writeJson(file, rawPage, {spaces: 2})
  }
})()
