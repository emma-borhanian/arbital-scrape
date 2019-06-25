module.exports = {
  maxBy: (os,f)=> {
    os = os.map(o=>[o,f(o)])
    let max = Math.max(...os.map(o=>o[1]))
    for (let o of os) { if (max == o[1]) return o[0] }
  }
}
