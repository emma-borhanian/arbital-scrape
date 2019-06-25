let escapeHtml = require('escape-html')

// Process links like:
// [-arbital_front_page]
// [arbital_front_page]
// [arbital_front_page Front Page]
// [http://google.com Google]
module.exports = (unmatchedText, pageIndex, missingLinks)=>{
  let result = ''
  while (unmatchedText) {
    let match = unmatchedText.match(/(?<![\\\]])\[[-@+]?(?<linkUrl>[^\]\s\n]+)(?:(?<space>(?:\s|\n)+)(?<linkText>[^\]]+))?\](?!\(|\[)/)
    if (!match) break
    let [fullMatch] = match
    let {index,groups:{linkUrl,space,linkText}} = match
    let visualizationMatch = linkUrl.match(/^visualization\(([^)]*)\):$/)
    if (visualizationMatch) {
      result += unmatchedText.substring(0, index) + `<div class="react-demo" data-demo-name="${visualizationMatch[1]}"></div>`
      unmatchedText = unmatchedText.substring(index + fullMatch.length)
      continue
    }
    if (/^summary\([^)]*\):/.test(linkUrl) || ['toc:', 'summary:', 'fixme:', 'todo:', 'comment:'].includes(linkUrl)) {
      result += unmatchedText.substring(0, index) + unmatchedText.substring(index, index + 1)
      unmatchedText = unmatchedText.substring(index + 1)
      continue
    }
    if (!linkUrl.includes('://') && !linkUrl.includes('.html')) {
      let linkedPage = pageIndex[linkUrl]
      if (!linkedPage) {
        linkUrl = [linkUrl, linkText].join(space)
        linkText = undefined
        linkedPage = pageIndex[linkUrl]
      }
      let newResult = result + unmatchedText.substring(0, index)
      if (!linkedPage
        // Avoid transforming x[1] where [1] is a user.
        || (linkedPage.type != 'wiki' && /^\[\d+\]$/.test(fullMatch)) && /[a-zA-Z_]$/.test(newResult)) {
        missingLinks.add(fullMatch)
        result += unmatchedText.substring(0, index)
        result += fullMatch.replace(/(?<=(^|[^\\])(\\{2})*)_/g, '\\_')
        unmatchedText = unmatchedText.substring(index + fullMatch.length)
        continue
      }
      linkUrl = linkedPage.aliasOrId + '.html'
      linkText = linkText || linkedPage.name
    }
    let previousText = result + unmatchedText.substring(0, index)
    let nextChar = (unmatchedText.length > index + fullMatch.length) && unmatchedText[index + fullMatch.length]
    // Markdown separate link syntax
    if (nextChar == ':' && (!previousText || /\n\s*$/.test(previousText))) {
      result += unmatchedText.substring(0, index) + unmatchedText.substring(index, index + 1)
      unmatchedText = unmatchedText.substring(index + 1)
      continue
    }
    result += unmatchedText.substring(0, index)
    result +=  `<a href="${escapeHtml(linkUrl)}">${escapeHtml(linkText || linkUrl)}</a>`
    unmatchedText = unmatchedText.substring(index + fullMatch.length)
  }
  return result + unmatchedText
}
