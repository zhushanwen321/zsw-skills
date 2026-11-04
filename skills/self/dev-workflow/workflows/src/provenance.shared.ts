// ============================================================================
// provenance.shared.ts — saved 副本启动校验层（单一构建输入）
// 构建器把本文件拼在观测层与业务正文之前，随产物部署；文件尾的顶层 await 即校验
// 入口——zcode 产物发起即执行，无从跳过。pi 产物拼入函数但不调用（构建器剥除调用
// 行）：pi 侧无 ~/.zcode saved 部署目录，无从校验，保留函数使两侧业务字符串同源。
//
// 机制：构建器写 saved 副本（~/.zcode/workflows/<name>.dwf.ts）时同步写来源登记
// 文件（<name>.manifest.json，记录生成该副本的仓检出根与仓内产物相对路径——本机
// 绝对路径是运行时反查检出根的唯一来源，属机器本地功能数据，不入仓）。启动时读
// 登记文件并逐字节比对 saved 副本与仓内产物：不一致 = 副本被仓外直接编辑或仓内
// 产物被手改（都意味着本次执行的脚本不是构建器产出的那一版），抛错终止，消息含
// 恢复动作；登记文件 / saved 副本 / 检出根任一缺失 = WARN 放行（本机无该仓检出时
// 不硬拦发起，降级可见）。
// 刻意只比「副本 vs 仓内产物」、不含 src/ 源：源的在途未构建改动归 pre-commit 的
// build --check 管辖，混进启动校验会误拦正常发起——误拦会逼出绕行，校验就废了。
// ============================================================================
const PROV_WF_NAME = "__PROV_WF_NAME__";
const PROV_PROBE =
  "try{" +
  "var fs=require('fs'),path=require('path'),crypto=require('crypto'),os=require('os');" +
  "var dir=path.join(os.homedir(),'.zcode','workflows');" +
  "var mf=path.join(dir,process.argv[1]+'.manifest.json');" +
  "var sp=path.join(dir,process.argv[1]+'.dwf.ts');" +
  "var out=function(o){process.stdout.write(JSON.stringify(o))};" +
  "var raw;try{raw=fs.readFileSync(mf,'utf8')}catch(e){out({skip:'no-manifest'});return}" +
  "var m;try{m=JSON.parse(raw)}catch(e){out({skip:'no-manifest',reason:'unparsable'});return}" +
  "if(!m||typeof m.sourceRoot!=='string'||m.sourceRoot.charAt(0)!=='/'||typeof m.productRelPath!=='string'||m.productRelPath.indexOf('..')>=0){out({skip:'no-manifest',reason:'fields'});return}" +
  "var pp=path.join(m.sourceRoot,m.productRelPath);" +
  "var a,b;try{a=fs.readFileSync(sp)}catch(e){out({skip:'no-saved'});return}" +
  "try{b=fs.readFileSync(pp)}catch(e){out({skip:'no-repo',product:pp});return}" +
  "var h=function(x){return crypto.createHash('sha256').update(x).digest('hex').slice(0,12)};" +
  "out({ok:a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b)),savedH:h(a),productH:h(b)});" +
  "}catch(e){process.stdout.write(JSON.stringify({skip:'probe-error',reason:String(e&&e.message||e)}))}";

/** saved 副本启动校验（机制见文件头注）：读来源登记文件并逐字节比对 saved 副本与
 *  仓内产物；不一致抛错终止（恢复动作在消息内），登记文件/副本/检出根缺失 WARN 放行 */
async function provenanceCheck(): Promise<void> {
  const r = await world.run("node", ["-e", PROV_PROBE, PROV_WF_NAME]);
  let v: { skip?: string; reason?: string; ok?: boolean; savedH?: string; productH?: string };
  try {
    v = JSON.parse(r.stdout.trim()) as typeof v;
  } catch {
    log(`WARN: 启动校验探针输出不可解析（exit ${r.exitCode}：${(r.stderr !== "" ? r.stderr : r.stdout).trim().slice(0, 200)}）——跳过本次启动校验`);
    return;
  }
  if (v.skip !== undefined) {
    const detail = v.reason !== undefined ? `（${v.reason}）` : "";
    log(`WARN: 来源登记文件或检出根缺失（${v.skip}${detail}）——跳过启动校验，本次发起未验证部署副本一致性`);
    return;
  }
  if (v.ok === true) {
    log(`启动校验通过：saved 副本与仓内产物一致（${PROV_WF_NAME}）`);
    return;
  }
  throw new Error(
    `saved 副本漂移：${PROV_WF_NAME} 的部署副本与仓内产物不一致（副本 sha256 前 12 位 ${v.savedH}，仓内产物 ${v.productH}）——副本被仓外直接编辑或仓内产物被手改，本次发起的不是构建器产出版本。恢复动作：在仓检出根跑 node scripts/build-workflows.mjs 重建并同步三处产物后重新发起；修订续跑配方与禁止直改副本见 workflow-authoring 第 4 节`,
  );
}
await provenanceCheck();
