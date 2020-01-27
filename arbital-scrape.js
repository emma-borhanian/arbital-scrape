#!/usr/bin/env node --max-old-space-size=16000
let fs = require('fs-extra')
let request = require('request-promise-native')
let {StatusCodeError,RequestError} = require('request-promise-native/errors')
let sanitizeFilename = require('sanitize-filename')
let colors = require('colors')
let util = require('util')
let path = require('path')
let Zip = require('adm-zip')
let escapeHtml = require('escape-html')
let flatMap = require('array.prototype.flatmap')
let DiffMatchPatch = require('diff-match-patch')

let config = require('./config.js')
let lib = require('./src/lib.js')
let renderPageText = require('./src/render-page-text.js')
let renderPageLinks = require('./src/render-page-links.js')

String.prototype.rsplit = function(sep, maxsplit) {
  var split = this.split(sep);
  return maxsplit ? [ split.slice(0, -maxsplit).join(sep) ].concat(split.slice(-maxsplit)) : split;
}

let argv = require('yargs')
  .command('$0 [directory]', 'scrape arbital.com restartable', yargs=>
    yargs.positional('directory', {
           desc: 'destination directory',
           string: true,
           default: `${__dirname}/out` })
         .option('url', {
           desc: 'arbital url',
           default: 'https://arbital.com' })
         .option('page', {
           desc: 'pages to download or start at',
           array: true,
           string: true,
           default: ['arbital_front_page'] })
         .option('request-history', {
           desc: 'request page history from arbital',
           boolean: true,
           default: false })
         .option('recursive', {
           desc: 'download recursively',
           boolean: true,
           default: true })
         .option('timeout', {
           desc: 'timeout (ms) per page',
           number: true,
           default: 7000 })
         .option('cache-only', {
           desc: 'make no http requests',
           boolean: true,
           default: true })
         .option('remote-mathjax', {
           desc: 'use remote mathjax rather than vendored',
           boolean: true,
           default: true }))
  .help()
  .argv

let template = require('./src/template.js')(argv)

if (!argv['cache-only'] && argv['recursive']) throw "Please don't hit arbital's servers without good reason. They're slow enough as it is."

let CacheOnlyError = class extends Error {constructor(){super('--cache-only enabled');this.name = 'CacheOnlyError'}}

const PageStatus_aliasOrId = 1
const PageStatus_pageRef   = 2
const PageStatus_page      = 3

let Page
let PageRef = class {
  constructor(aliasOrIdOrPartialPageJson, aliasToId, requestedEdit=null, status=PageStatus_pageRef) {
    this.cached = false
    if (typeof(aliasOrIdOrPartialPageJson) == "string") {
      this._copyProperties(PageStatus_aliasOrId, { aliasOrId: aliasOrIdOrPartialPageJson}, aliasToId, requestedEdit)
    } else {
      this._copyProperties(status, aliasOrIdOrPartialPageJson, aliasToId, requestedEdit)
    }
    this.downloaded = false
  }

  _copyProperties(status, p, aliasToId, requestedEdit) {
    this.status = status
    this.partialPageJson = p
    this.pageId = p.pageId || aliasToId[p.aliasOrId]
    this.alias = p.alias
    this.aliasOrId = this.alias || this.pageId || p.aliasOrId
    this.requestedEdit = requestedEdit
    this.edit = 'edit' in p ? parseInt(p.edit) : requestedEdit
    this.currentEdit = 'currentEdit' in p ? parseInt(p.currentEdit) : undefined
    this.keys = Array.from(new Set([this.aliasOrId, this.pageId, this.alias].filter(k=>typeof(k)!='undefined')))
    this.type = p.type || config.defaultTypeString
    this.title = p.title || ''
    this.text = p.text || ''
    this.clickbait = p.clickbait || ''
    this.name = this.title
      || (this.clickbait && this.clickbait.substring(config.textToNameMaxLength))
      || (this.text && this.text.substring(config.textToNameMaxLength))
      || this.aliasOrId
    this.named = config.namelikePageIds.includes(this.name) || this.title || this.clickbait || this.text || this.alias
    this.arbitalUrl = `https://arbital.com/p/${this.aliasOrId}`
    this.pageCreatedAt = p.pageCreatedAt && new Date(p.pageCreatedAt)
    this.editCreatedAt = p.editCreatedAt && new Date(p.editCreatedAt)
    this.childIds = p.childIds || []
    this.parentIds = p.parentIds || []
    this.pageCreatorId = p.pageCreatorId
    this.editCreatorId = p.editCreatorId
    this.creatorIds = p.creatorIds || []
    this.editorIds = this.creatorIds.filter(i=>i!=this.pageCreatorId)
    this.tagIds = p.tagIds || []
    this.individualLikes = p.individualLikes || []
    this.relatedIds = p.relatedIds || []
    this.commentIds = p.commentIds || []
    this.anchorContext = p.anchorContext
    this.anchorText = p.anchorText
    this.anchorOffset = p.anchorOffset
    this.changeLogs = p.changeLogs || []

    this.missingLinks = []
    this.latexStrings = []
    this.requestError = null

    this.editPageRefs = []
    if (this.requestedEdit == null) {
      for (let i = 1; i< this.currentEdit; i++) {
        this.editPageRefs.push(new PageRef({ pageId: this.pageId, aliasOrId: this.aliasOrId, alias: this.alias }, aliasToId, i))
      }
    }

    this.reverse = {
      pageCreatorId: new Set(),
      editorIds: new Set(),
      relatedIds: new Set(),
    }

    this.rawFile = this.requestedEdit == null
        ? `${argv.directory}/raw/${sanitizeFilename(this.pageId || this.aliasOrId)}.json`
        : `${argv.directory}/raw-history/${sanitizeFilename(`${this.pageId || this.aliasOrId}-${this.edit}`)}.json`
    this.metadataFile = this.requestedEdit == null
        ? `${argv.directory}/metadata/${sanitizeFilename(this.aliasOrId)}.json.html`
        : `${argv.directory}/metadata-history/${sanitizeFilename(`${this.aliasOrId}-${this.edit}`)}.json.html`
    this.pageFile = this.requestedEdit == null
        ? `${argv.directory}/page/${sanitizeFilename(this.aliasOrId)}.html`
        : `${argv.directory}/page-history/${sanitizeFilename(`${this.aliasOrId}-${this.edit}`)}.html`
    this.diffFile = `${argv.directory}/page-diff/${sanitizeFilename(`${this.aliasOrId}-${this.edit || '1'}`)}.html`
  }

  propagateReverse(pageIndex) {
    for (let k of Object.keys(this.reverse)) {
      let v = this[k] instanceof Array ? this[k] : [this[k]]
      let page = this
      v.map(p=>pageIndex[p]).filter(p=>p).forEach(o=>o.reverse[k].add(page))
    }
  }

  async _requestRawPage() {
    if (argv['cache-only']) throw new CacheOnlyError()
    let url = this.requestedEdit == null
        ? `${argv.url}/json/primaryPage/`
        : `${argv.url}/json/edit/`
    let body = this.requestedEdit == null
        ? { pageAlias: this.aliasOrId }
        : { pageAlias: this.aliasOrId, specificEdit: this.requestedEdit }
    this.log('fetching', 'POST', url, body)
    return await request({
      method: 'POST',
      url: url,
      json: true,
      body: body,
      timeout: argv.timeout })
  }

  async _loadCachedPage() {
    if (this.status == PageStatus_page) return this
    if (await fs.pathExists(this.rawFile)) {
      let r = new Page(this.aliasOrId, await fs.readJson(this.rawFile), this.requestedEdit)
      r.log('found cached', path.relative('.', this.rawFile))
      r.cached = true
      return r
    }
    return null
  }

  async loadOrRequestCachedPage() {
    let page = await this._loadCachedPage()
    if (page != null) return page
    let rawPage = await this._requestRawPage()
    return new Page(this.aliasOrId, rawPage, this.requestedEdit)
  }

  renderSummary(pageIndex) {
    if (typeof(this.summary) != "undefined") return this.summary
    let summary = this.clickbait || ''
    if (!summary && this.text) {
      let match = this.text.match(/\[summary(\([^\)]&\))?:/)
      let text = match ? this.text.substring(match.index + match[0].length) : this.text
      summary = renderPageLinks(text, pageIndex, /*missingLinks=*/new Set(), /*textOnly=*/true)
      if (summary.length > config.textToSummaryMaxLength) {
        summary = summary.substring(0,config.textToSummaryMaxLength) + '…'
      }
    }
    summary = summary.trim()
    if (/^Automatically generated (page|group)/.test(summary)) {
      return ''
    }
    return this.summary = summary
  }

  log(command, ...args) { console.log(command, this.aliasOrId, util.inspect(this.title || ''), ...args) }

  pickBest(...others) { return lib.maxBy([this].concat(others).filter(p=>p), p=>p.status) }
}

let findPageInRawPageJson = (aliasOrId, rawPageJson)=>
  rawPageJson.pages[aliasOrId]
    || Object.values(rawPageJson.pages).find(p=>p.alias==aliasOrId)
    || {aliasOrId: aliasOrId}
// TODO: left out 'id' because it leads to downloading tens of thousands of empty change log objects.
let isArbitalPageIdField = k=>k !='analyticsId' && (['individualLikes'].includes(k) || k.endsWith('Ids') || k.endsWith('Id'))

Page = class extends PageRef {
  constructor(aliasOrId, rawPageJson, requestedEdit=null) {
    super(findPageInRawPageJson(aliasOrId, rawPageJson), /* aliasToId= */{}, requestedEdit, PageStatus_page)
    this.rawPageJson = rawPageJson
    this.pageJson = this.partialPageJson
    this.downloaded = true
  }

  async _writeFile(file, json) {
    this.log('writing', path.relative('.', file))
    await fs.mkdirp(path.dirname(file))
    await fs.writeFile(file, json)
    return file
  }

  async _writeJson(file, json) {
    this.log('writing', path.relative('.', file))
    await fs.mkdirp(path.dirname(file))
    await fs.writeJson(file, json, {spaces: 2})
    return file
  }

  _makeBreadcrumbs(pageIndex) {
    let breadcrumbs = []
    let addBreadcrumbs = (stack,breadcrumbPage)=>{
      if (!breadcrumbPage) return
      stack = Array.from(stack)
      if (breadcrumbPage.parentIds.length > 0) {
        breadcrumbPage.parentIds.forEach(p=>addBreadcrumbs(stack.concat([pageIndex[p]]),pageIndex[p]))
      } else if (stack.length > 0) {
        stack.reverse()
        breadcrumbs.push(flatMap(stack, p=>[`${p.aliasOrId}.html`, p.name]).concat('…'))
      }
    }
    addBreadcrumbs([], this)
    return breadcrumbs.sort()
  }

  renderText(pageIndex) {
    if (this.textHtml) return this.textHtml
    let missingLinks = new Set()
    this.textHtml = renderPageText(this, pageIndex, missingLinks, this.latexStrings = [])
    this.missingLinks = Array.from(missingLinks).sort()
    return this.textHtml
  }

  get diff() {
    if (this._diff) return this._diff
    let prevPage = null
    for (let i = this.edit - 1; i >= 1 && (!prevPage || !prevPage.downloaded); i--) {
      prevPage = this.requestedEdit ? this.currentEditPage.editPageRefs[i-1] : this.editPageRefs[i-1]
    }
    let diffText = p=>`${p.title}\n\n${p.clickbait}\n\n${p.text}`
    let diffMatchPatch = new DiffMatchPatch()
    diffMatchPatch.Diff_EditCost = 4
    let diffs = diffMatchPatch.diff_main(prevPage ? diffText(prevPage) : '', diffText(this))
    diffMatchPatch.diff_cleanupSemantic(diffs)
    let added = 0
    let removed = 0
    for (let [dir, s] of diffs) {
      if (dir < 0) removed += s.length
      if (dir > 0) added += s.length
    }
    return this._diff = {
      added: added,
      removed: removed,
      html: diffMatchPatch.diff_prettyHtml(diffs).replace(/&para;/g, '')
    }
  }

  _renderDiff(pageIndex) { return template.pageDiff({...this, diff:this.diff, pageIndex:pageIndex}) }
  _renderPage(pageIndex) { return template.page({...this, textHtml: this.renderText(pageIndex), breadcrumbs:this._makeBreadcrumbs(pageIndex), diff:this.diff, pageIndex:pageIndex}) }

  async saveRaw() { if (!this.cached) await this._writeJson(this.rawFile, this.rawPageJson) }

  _renderMetadataHtml(pageIndex) {
    let jsonWalkReplace =(o,f,k='')=>{
      if (o instanceof Array) {
        return o.map(x=>jsonWalkReplace(x,f,k))
      } else if (o instanceof Object) {
        let r={}
        for (let ok of Object.keys(o)) r[escapeHtml(ok)] = jsonWalkReplace(o[ok],f,ok)
        return r
      } else {
        return f(o,k)
      }
    }
    let pageJsonHtml = jsonWalkReplace(this.pageJson, (scalar, key)=> {
      let page
      if (!isArbitalPageIdField(key) || !(page = pageIndex[scalar])) return escapeHtml(scalar)
      return template.metadataLink(page)
    })
    return template.metadata({...this, pageJsonHtml:pageJsonHtml, util:util})
  }

  async saveHtml(pageIndex) {
    await this._writeFile(this.pageFile, this._renderPage(pageIndex))
    await this._writeFile(this.metadataFile, this._renderMetadataHtml(pageIndex))
    await this._writeFile(this.diffFile, this._renderDiff(pageIndex))
  }

  findPageRefs(aliasToId) {
    let walkJson = (json, func, key='')=>{
      if (json instanceof Array) {
        json.forEach(v=>walkJson(v, func, key))
      } else if (json instanceof Object) {
        Object.keys(json).forEach(k=>walkJson(json[k], func, k))
      } else {
        func(key, json)
      }
    }

    return this._pageRefs = this._pageRefs || (()=>{
      let pageRefs = []

      if (argv['request-history']) {
        pageRefs.push(...this.editPageRefs)
      }

      pageRefs.push(...Object.values(this.rawPageJson.pages).map(p=>new PageRef(p, aliasToId)))
      walkJson(this.rawPageJson, (k,v)=> { if (isArbitalPageIdField(k) && v) pageRefs.push(new PageRef(v, aliasToId)) })

      return pageRefs
    })()
  }
}

;(async ()=>{
  await fs.mkdirp(argv.directory)

  let scrapeMetadataFile = `${argv.directory}/metadata.json`
  let lastScrapeMetadata = {}
  if (await fs.pathExists(scrapeMetadataFile)) {
    console.log('reading', scrapeMetadataFile)
    lastScrapeMetadata = await fs.readJson(scrapeMetadataFile)
  }
  let aliasToId = lastScrapeMetadata.aliasToId || {}
  let fetchFailures = lastScrapeMetadata.fetchFailures || {}

  let toDownload = Array.from(argv.page.map(p=>new PageRef(p, aliasToId)))
  let pageIndex = {}

  if (argv.recursive) {
    let rawHistoryDir = `${argv.directory}/raw-history`
    await fs.mkdirp(rawHistoryDir)
    let cachedPageFiles = await util.promisify(fs.readdir)(rawHistoryDir)
    cachedPageFiles.forEach(f=>{ if (f.endsWith('.json')) {
      let [pageId, requestedEdit] = f.replace(/\.json$/, '').rsplit('-')
      toDownload.push(new PageRef(pageId, aliasToId, requestedEdit))
    }})

    let rawDir = `${argv.directory}/raw`
    await fs.mkdirp(rawDir)
    cachedPageFiles = await util.promisify(fs.readdir)(rawDir)
    cachedPageFiles.forEach(f=>{ if (f.endsWith('.json')) toDownload.push(new PageRef(f.replace(/\.json$/, ''), aliasToId)) })
  }

  let addToIndex =p=>{
    if (p.requestedEdit != null) return
    p = pageIndex[p.aliasOrId.toLowerCase()] = pageIndex[p.aliasOrId] = pageIndex[p.aliasOrId] ? pageIndex[p.aliasOrId].pickBest(p) : p
    if (p.alias && p.pageId) aliasToId[p.alias] = p.pageId
    if (p.pageId) { pageIndex[p.pageId] = p; pageIndex[p.pageId.toLowerCase()] = p }
    if (p.alias) { pageIndex[p.alias] = p; pageIndex[p.alias.toLowerCase()] = p }
    if (p.title) { pageIndex[p.title] = p; pageIndex[p.title.toLowerCase()] }
  }
  toDownload.forEach(addToIndex)

  let visited = {}
  while (toDownload.length > 0) {
    let pageRef = toDownload.pop()
    if (pageRef.requestedEdit == null) pageRef = pageRef.pickBest(...pageRef.keys.map(k=>pageIndex[k]))

    if (pageRef.keys.some(k=>visited[k] && visited[k].has(pageRef.requestedEdit))) continue
    let addToVisited = p=> p.keys.forEach(k=>{ visited[k] = visited[k] || new Set(); visited[k].add(p.requestedEdit) })

    let page
    if (pageRef.status == PageStatus_page) {
      page = pageRef
    } else {
      try { page = await pageRef.loadOrRequestCachedPage() } catch (e) {
        addToVisited(pageRef)
        if (e instanceof StatusCodeError || e instanceof RequestError || e instanceof CacheOnlyError) {
          let lastError = fetchFailures[pageRef.aliasOrId] && fetchFailures[pageRef.aliasOrId][pageRef.requestedEdit || 'current']
          if (e instanceof CacheOnlyError && lastError && lastError.name != 'CacheOnlyError') e = lastError
          pageRef.requestError = e
          pageRef.log(colors.red('failed'), e.message)
          fetchFailures[pageRef.aliasOrId] = fetchFailures[pageRef.aliasOrId] || {}
          fetchFailures[pageRef.aliasOrId][pageRef.requestedEdit || 'current'] = e
          continue
        } else throw e
        if (fetchFailures[pageRef.aliasOrId]) {
          delete fetchFailures[pageRef.aliasOrId][pageRef.requestedEdit || 'current']
          if (Object.keys(fetchFailures[pageRef.aliasOrId]).length == 0) {
            delete fetchFailures[pageRef.aliasOrId]
          }
        }
      }

      await page.saveRaw()
    }

    if (page.requestedEdit) pageIndex[page.aliasOrId].editPageRefs[page.requestedEdit - 1] = page
    else addToIndex(page)
    let subPageRefs = page.findPageRefs(aliasToId)
    subPageRefs.forEach(addToIndex)
    if (argv.recursive) toDownload.push(...subPageRefs)
    addToVisited(page)
  }

  let scrapeMetadata = {aliasToId:aliasToId, fetchFailures:fetchFailures}
  console.log('writing', scrapeMetadataFile)
  await fs.writeJson(scrapeMetadataFile, scrapeMetadata)

  let allPages = lib.sortBy(Array.from(new Set(Object.values(pageIndex))), p=>p.name)

  allPages.forEach(p=>p.propagateReverse(pageIndex))
  allPages.forEach(p=>{
    p.currentEditPage = p
    p.editPageRefs.forEach(e=>e.currentEditPage = p)
  })

  let savedHtml = new Set()
  for (let page of allPages) {
    if (page.status == PageStatus_page && !savedHtml.has(page.pageId)) {
      savedHtml.add(page.pageId)
      await page.saveHtml(pageIndex)
      for (let oldPage of page.editPageRefs) {
        if (oldPage.status == PageStatus_page) {
          await oldPage.saveHtml(pageIndex)
        }
      }
    }
  }

  let namedTypes = lib.makePagesByType(allPages.filter(p=>p.named), pageIndex).map(e=>e[0])
  let unnamedTypes = lib.makePagesByType(allPages.filter(p=>!p.named), pageIndex).map(e=>e[0])

  let writeFile = async (file,content)=>{
    console.log('writing', path.relative('.', file))
    await fs.mkdirp(path.dirname(file))
    await fs.writeFile(file, content)
  }
  let copyFile = async (source,destination,content)=>{
    console.log('copying', path.relative('.', source), 'to', path.relative('.', destination))
    await fs.copyFile(source, destination)
  }

  let indexLocals = {pageIndex:pageIndex, allPages:allPages, namedTypes:namedTypes, unnamedTypes:unnamedTypes}

  await writeFile(`${argv.directory}/index.html`, template.index({title: 'Arbital Scrape Index', ...indexLocals}))
  await writeFile(`${argv.directory}/debug.html`, template.debug({title: 'Debug', fetchFailures: fetchFailures, ...indexLocals}))
  await writeFile(`${argv.directory}/debug-all-mathjax.html`, template.debugAllMathjax({title: 'Debug - All Mathjax', ...indexLocals}))
  await writeFile(`${argv.directory}/by-type-named.html`, template.indexByType({title: 'By Type (Named)', ...indexLocals, allPages:allPages.filter(p=>p.named)}))
  await writeFile(`${argv.directory}/by-type-unnamed.html`, template.indexByType({title: 'By Type (Unnamed)', ...indexLocals, allPages:allPages.filter(p=>!p.named)}))

  for (let file of ['page-style.css', 'index-style.css', 'common.css']) {
    await copyFile(`template/${file}`, `${argv.directory}/${file}`)
  }

  let exploreRoots = allPages.filter(p=>p.status == PageStatus_page && p.childIds.length > 0 && p.parentIds.length == 0)
  let explorePagesByCategory = {}
  exploreRoots.forEach(p=>(explorePagesByCategory[p.aliasOrId] = explorePagesByCategory[p.aliasOrId] || []).push(...p.childIds))
  await writeFile(`${argv.directory}/explore.html`, template.explore({title: 'Explore', pagesByCategory:explorePagesByCategory, ...indexLocals}))

  let makePagesByCategory = f=>{
    let pagesByCategory = {}
    allPages.forEach(p=>f(p).filter(i=>i).forEach(indexKey=>{
      indexKey = pageIndex[indexKey] ? pageIndex[indexKey].aliasOrId : indexKey
      ;(pagesByCategory[indexKey] = pagesByCategory[indexKey] || []).push(p)
    }))
    return lib.sortBy(Object.entries(pagesByCategory), e=>pageIndex[e[0]] ? pageIndex[e[0]].name : e[0])
  }

  await writeFile(`${argv.directory}/by-creator.html`, template.indexByCategory({title: 'By Creator', skipCreator: true, pagesByCategory:makePagesByCategory(p=>p.pageCreatorId==p.pageId?[]:[p.pageCreatorId]), ...indexLocals}))
  await writeFile(`${argv.directory}/by-editor.html`, template.indexByCategory({title: 'By Editor', pagesByCategory:makePagesByCategory(p=>p.editorIds), ...indexLocals}))
  await writeFile(`${argv.directory}/by-tag.html`, template.indexByCategory({title: 'By Tag', pagesByCategory:makePagesByCategory(p=>p.tagIds), ...indexLocals}))
  await writeFile(`${argv.directory}/by-likes.html`, template.indexByCategory({title: 'By Likes', pagesByCategory:makePagesByCategory(p=>p.individualLikes), ...indexLocals}))

  let fetchUrl = async (url,options)=> {
    console.log('fetching', url)
    try { return await request({method: 'GET', url: url, ...options})
    } catch (e) { console.log(colors.red('failed'), url, e.message) }
  }
  let fetchUrlAsCachedFile = async (file, url, options={})=> {
    if (!options.encoding) options.encoding = null
    if (!await fs.pathExists(file)) {
      let content = await fetchUrl(url, options)
      if (!content) throw `No content at ${url}`
      await writeFile(file, content)
    }
    return file
  }

  if (!argv['remote-mathjax'] && !await fs.pathExists(`${argv.directory}/MathJax-${sanitizeFilename(config.mathjaxVersion)}`)) {
    let mathjaxZipFile = await fetchUrlAsCachedFile(
      `tmp/mathjax-${sanitizeFilename(config.mathjaxVersion)}.zip`,
      `https://github.com/mathjax/MathJax/archive/${config.mathjaxVersion}.zip`)
    console.log('extracting', mathjaxZipFile, 'to', path.relative('.', argv.directory))
    new Zip(mathjaxZipFile).extractAllTo(argv.directory, /*overwrite=*/false)
  }

  if (!argv['cache-only']) {
    await fetchUrlAsCachedFile(`${argv.directory}/unused/arbital-bundle.js`, `${argv.url}/static/js/bundle.js`)
    await fetchUrlAsCachedFile(`${argv.directory}/arbital-demo-bundle.js`, `${argv.url}/static/js/lib/demo-bundle.js`)
  }

  if (Object.keys(fetchFailures).length > 0) {
    console.log('')
    console.log('Fetch failures:')
    for (let aliasOrId of Object.keys(fetchFailures)) {
      for (let editNumber of Object.keys(fetchFailures[aliasOrId])) {
        let error = fetchFailures[aliasOrId][editNumber]
        let page = editNumber == 'current' ? pageIndex[aliasOrId] : pageIndex[aliasOrId].editPageRefs[parseInt(editNumber) - 1]
        page.log(colors.red('failed'), editNumber, error.message)
      }
    }
  }
})()
