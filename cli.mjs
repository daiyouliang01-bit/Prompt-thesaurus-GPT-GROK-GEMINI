// 命令行工具：供 Claude Code 技能和终端使用。运行方式：bin/plib <命令> [参数]
import fs from 'node:fs';
import path from 'node:path';
import * as store from './lib/db.mjs';
import { DATA } from './lib/paths.mjs';
import { copyImageFile } from './lib/files.mjs';
import { runGeneration, autoTag } from './lib/generate.mjs';
import { relaunchWithProxy } from './lib/proxy-env.mjs';

const HELP = `提示词库命令行（plib）

  stats                                  库的统计
  categories                             列出 15 个类别及案例数
  models                                 按模型统计（GPT Image 2 / Nano Banana Pro / ChatGPT …）
  subcategories [C06]                    细分类列表及案例数
  search <关键词...> [--cat C06] [--sub C06-02] [--model "Nano Banana Pro"] [--media image|video]
         [--source user|canghe|opennana|github] [--fav] [--limit 20] [--json]
  show <id> [--json]                     查看案例完整内容
  template <C01..C15|rules>              输出类别模板或通用规则（Markdown）
  retrieve --keywords "水墨,城市海报" [--cat C06] [--secondary C03,C14] [--limit 6] [--pin 12,34] [--json]
                                         为写提示词检索最相关的参考案例（含完整提示词）
  add --title T (--prompt P | --prompt-file F) [--cat C06] [--subtype S] [--tags "a,b"]
      [--analysis A] [--image 图片路径] [--url 来源] [--note N] [--fav] [--auto]
                                         加入一条提示词；--auto 用已配置的模型自动补全归类与分析
  update <id> [同 add 的字段]            修改案例（--image 替换配图）
  favorite <id>                          切换收藏
  delete <id>                            删除案例
  generate --goal "想要的效果" [--image 参考图路径] [--cat C06] [--ar 9:16] [--lang zh|en|both] [--pin 12,34]
           [--model "GPT Image 2.5"] [--output auto|image|video] [--fast] [--json]
                                         默认精细模式（参考图局部放大 + 对照需求自检），--fast 只写一遍
  generate-refine --id 生成记录编号 --image 生成结果图片 [--lang zh|en|both] [--hint 补充说明] [--json]
                                         对照需求和参考图检查生成结果，修正提示词（可以多轮）
                                         用已配置的 OpenAI 兼容模型：分析→检索→生成提示词
  reverse (--image 路径或链接 | --video 路径或链接) [--model "Seedance 2.0"] [--output auto|image|video] [--lang zh|en|both]
          [--hint 补充说明] [--frames 8] [--fast] [--json]
                                         用已配置的视觉模型反推图片/视频的提示词（视频自动抽帧，需要 ffmpeg）；
                                         默认精细模式（局部放大 + 对照原图自检），--fast 只做一遍
  drive status                           查看 Google 云盘连接状态和同步进度（连接请在网页「设置」里操作）
  drive sync [--limit N] [--only images|videos] [--concurrency 3]
                                         把图片和视频同步到 Google 云盘（可随时 Ctrl+C 中断，下次接着传）
  reverse-refine --id 反推记录编号 --image 生成结果图片 [--lang zh|en|both] [--hint 补充说明] [--json]
                                         对比原图与生成结果，找出差异并修正提示词（可以多轮）
  history [--limit 10]                   最近的生成记录
  settings [--base-url U] [--api-key K] [--model M] [--vision-model V]
                                         查看或修改模型接口配置
`;

function parseArgs(argv) {
  const args = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const next = argv[i + 1];
      args[k] = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
    } else pos.push(argv[i]);
  }
  return { args, pos };
}

const [cmd, ...rest] = process.argv.slice(2);
const { args, pos } = parseArgs(rest);
const out = obj => console.log(JSON.stringify(obj, null, 2));
const ids = v => (typeof v === 'string' ? v.split(/[,\s]+/).map(Number).filter(Number.isFinite) : []);

function fieldsFromArgs() {
  const data = {};
  if (typeof args.title === 'string') data.title = args.title;
  if (typeof args.prompt === 'string') data.prompt = args.prompt;
  if (typeof args['prompt-file'] === 'string') data.prompt = fs.readFileSync(args['prompt-file'], 'utf8');
  if (typeof args.cat === 'string') { data.category_code = args.cat.toUpperCase(); data.classify_source = 'manual'; }
  if (typeof args.sub === 'string') { data.subcategory = args.sub.toUpperCase(); data.classify_source = 'manual'; }
  if (typeof args.model === 'string') data.model = args.model;
  if (typeof args.subtype === 'string') data.subtype = args.subtype;
  if (typeof args.tags === 'string') data.tags = args.tags;
  if (typeof args.analysis === 'string') data.analysis = args.analysis;
  if (typeof args.url === 'string') data.source_url = args.url;
  if (typeof args.note === 'string') data.note = args.note;
  if (args.fav) data.favorite = true;
  return data;
}

function printCase(c) {
  console.log(`#${c.id} ${c.title}`);
  const src = c.source === 'user' ? '我添加的' : c.source === 'opennana' ? `OpenNana #${c.source_case_id}`
    : c.source === 'github' ? `GitHub 精选 ${c.source_case_id}` : `网站案例 #${c.source_case_id}`;
  console.log(`类别：${c.category_code || '-'}　细分类：${c.subcategory || '-'}　子类型：${c.subtype || '-'}　模型：${c.model || '-'}　来源：${src}${c.favorite ? '　★收藏' : ''}`);
  if (c.video_url) console.log(`视频：${c.video_url}`);
  if (c.tags) console.log(`标签：${c.tags}`);
  if (c.image_path && fs.existsSync(path.join(DATA, c.image_path))) console.log(`配图：${path.join(DATA, c.image_path)}`);
  else if (c.image_url) console.log(`配图：${c.image_url}`);
  if (c.analysis) console.log(`\n【分析】\n${c.analysis}`);
  console.log(`\n【提示词】\n${c.prompt}\n`);
}

async function main() {
  switch (cmd) {
    case undefined: case 'help': case '--help': console.log(HELP); break;

    case 'stats': out(store.stats()); break;

    case 'categories':
      for (const c of store.listCategories()) console.log(`${c.code}  ${c.name}（${c.count}）— ${c.description}`);
      break;

    case 'models':
      for (const m of store.listModels()) console.log(`${m.model}\t${m.count}`);
      break;

    case 'subcategories':
      for (const s of store.listSubcategories(String(pos[0] || '').toUpperCase())) console.log(`${s.code}\t${s.name}（${s.count}）`);
      break;

    case 'search': {
      const r = store.searchCases({
        q: pos.join(' '), category: String(args.cat || '').toUpperCase(), subcategory: String(args.sub || '').toUpperCase(),
        model: typeof args.model === 'string' ? args.model : '', mediaType: typeof args.media === 'string' ? args.media : '',
        source: args.source || '', favorite: !!args.fav, limit: Number(args.limit) || 20,
      });
      if (args.json) return out(r);
      console.log(`共 ${r.total} 条，显示 ${r.items.length} 条`);
      for (const c of r.items) console.log(`#${c.id}\t${c.category_code || '-'}/${c.subcategory || '-'}\t${c.model || '-'}\t${c.title}\n\t${c.prompt_snippet}`);
      break;
    }

    case 'show': {
      const row = store.getCaseRow(pos[0]);
      if (!row) throw new Error('案例不存在');
      if (args.json) return out(store.toCase(row));
      printCase(row);
      break;
    }

    case 'template': {
      const key = String(pos[0] || '').toUpperCase();
      if (key === 'RULES') { console.log(store.getDoc('rules')?.content || ''); break; }
      const cat = store.getCategory(key);
      if (!cat) throw new Error('用法：template C01..C15 或 template rules');
      console.log(cat.template_md);
      break;
    }

    case 'retrieve': {
      const refs = store.retrieveReferences({
        keywords: [String(args.keywords || '')], category: String(args.cat || '').toUpperCase(),
        secondary: String(args.secondary || '').toUpperCase().split(',').filter(Boolean),
        limit: Number(args.limit) || 6, pinnedIds: ids(args.pin),
      });
      if (args.json) return out(refs);
      for (const r of refs) { printCase(r); console.log('----------'); }
      break;
    }

    case 'add': {
      const data = fieldsFromArgs();
      if (typeof args.image === 'string') data.image_path = copyImageFile(path.resolve(args.image));
      if (args.auto) {
        const t = await autoTag({ title: data.title, prompt: data.prompt, imagePath: typeof args.image === 'string' ? args.image : undefined });
        for (const k of ['title', 'category_code', 'subtype', 'tags', 'analysis']) if (!data[k] && t[k]) data[k] = t[k];
      }
      const c = store.createCase({ source: 'user', ...data });
      console.log(`已加入：#${c.id} ${c.title}（${c.category_code || '未分类'}）`);
      break;
    }

    case 'update': {
      const data = fieldsFromArgs();
      const old = store.getCaseRow(pos[0]);
      if (!old) throw new Error('案例不存在');
      if (typeof args.image === 'string') data.image_path = copyImageFile(path.resolve(args.image));
      const c = store.updateCase(pos[0], data);
      console.log(`已更新：#${c.id} ${c.title}`);
      break;
    }

    case 'favorite': {
      const old = store.getCaseRow(pos[0]);
      if (!old) throw new Error('案例不存在');
      const c = store.updateCase(pos[0], { favorite: !old.favorite });
      console.log(`#${c.id} ${c.favorite ? '已收藏' : '已取消收藏'}`);
      break;
    }

    case 'delete': store.deleteCase(pos[0]); console.log(`已删除 #${pos[0]}`); break;

    case 'generate': {
      const r = await runGeneration({
        goal: args.goal === true ? '' : args.goal, imagePath: typeof args.image === 'string' ? args.image : undefined,
        category: args.cat, aspectRatio: args.ar, lang: args.lang || 'zh', referenceIds: ids(args.pin),
        targetModel: typeof args.model === 'string' ? args.model : '', output: typeof args.output === 'string' ? args.output : 'auto',
        detail: !args.fast,
      });
      if (args.json) return out(r);
      const gi = r.analysis.generation || {};
      console.log(`类别：${r.category.code} ${r.category.name}　子类型：${r.analysis.subtype || '-'}　写法：${gi.target_model || '通用'}${gi.output === 'video' ? '（出视频）' : ''}${gi.person_mode ? '　人物保持' : ''}　（记录 #${r.id}）`);
      if (gi.notice) console.log(`提示：${gi.notice}`);
      console.log(`参考案例：${r.references.map(x => '#' + x.id).join(' ')}\n`);
      if ((r.result.review || []).length) {
        console.log('【AI 自检修正】');
        for (const x of r.result.review) console.log(`- ${x.item || ''}：${x.problem || ''} → ${x.fix || ''}`);
        console.log('');
      }
      console.log(`【提示词】\n${r.result.prompt}\n`);
      if (r.result.prompt_en) console.log(`【English】\n${r.result.prompt_en}\n`);
      if (r.result.negative) console.log(`【避免项】\n${r.result.negative}\n`);
      break;
    }

    case 'reverse': {
      const { runReverse } = await import('./lib/reverse.mjs');
      const r = await runReverse({
        imageSrc: typeof args.image === 'string' ? args.image : '', videoSrc: typeof args.video === 'string' ? args.video : '',
        targetModel: typeof args.model === 'string' ? args.model : '', lang: args.lang || 'zh',
        hint: typeof args.hint === 'string' ? args.hint : '', frames: Number(args.frames) || 8, allowLocal: true,
        output: typeof args.output === 'string' ? args.output : 'auto', detail: !args.fast,
      });
      if (args.json) return out({ ...r, media: { ...r.media, frames: r.media.frames.map(f => ({ t: f.t })) } });
      const m = r.media;
      if (r.notice) console.log(`提示：${r.notice}`);
      console.log(`素材：${m.media_type === 'video' ? `视频 ${m.duration} 秒，抽 ${m.frames.length} 帧` : '图片'}（${m.width}×${m.height}，约 ${m.aspect}）　写法：${m.target_model}　类别：${r.category.code} ${r.category.name}　（记录 #${r.id}）`);
      console.log(`参考案例：${r.references.map(x => '#' + x.id).join(' ') || '无'}\n`);
      if (r.result.title) console.log(`【标题】${r.result.title}\n`);
      console.log(`【提示词】\n${r.result.prompt}\n`);
      if (r.result.prompt_en) console.log(`【English】\n${r.result.prompt_en}\n`);
      if (r.result.negative) console.log(`【避免项】\n${r.result.negative}\n`);
      for (const s of Array.isArray(r.analysis.shots) ? r.analysis.shots : []) {
        console.log(`  ${s.time || ''}｜${s.shot || ''}｜${s.camera_move || ''}｜${s.action || ''}${s.expression ? `｜${s.expression}` : ''}`);
      }
      break;
    }

    case 'generate-refine': {
      const { refineGeneration } = await import('./lib/generate.mjs');
      if (typeof args.image !== 'string') throw new Error('用法：generate-refine --id 生成记录编号 --image 生成结果图片');
      const r = await refineGeneration({
        id: args.id, imageSrc: args.image, lang: typeof args.lang === 'string' ? args.lang : '',
        hint: typeof args.hint === 'string' ? args.hint : '', allowLocal: true,
      });
      if (args.json) return out(r);
      const gi = r.analysis.generation || {};
      console.log(`第 ${gi.round} 轮修正（记录 #${r.id}，基于 #${gi.refined_from}）\n`);
      console.log('【发现的问题】');
      for (const d of r.result.review || []) console.log(`- ${d.aspect || ''}：应为 ${d.expected || '-'}；生成 ${d.generated || '-'} → ${d.fix || ''}`);
      console.log(`\n【修正后的提示词】\n${r.result.prompt}\n`);
      if (r.result.negative) console.log(`【避免项】\n${r.result.negative}\n`);
      break;
    }

    case 'drive': {
      const gdrive = await import('./lib/gdrive.mjs');
      const ds = await import('./lib/drive-sync.mjs');
      const sub = pos[0] || 'status';
      if (sub === 'status') {
        const s = gdrive.publicStatus();
        const c = ds.syncCounts();
        const est = ds.estimate();
        if (args.json) return out({ ...s, counts: c, estimate: est });
        console.log(s.connected ? `已连接 Google 云盘：${s.email}` : s.configured ? '凭据已保存，还没有连接（请在网页「设置」里点「连接 Google 云盘」）' : '还没有配置 Google 云盘');
        if (s.connected) {
          const q = (await gdrive.about()).storageQuota || {};
          console.log(`云盘空间：已用 ${ds.fmtBytes(q.usage)} / 共 ${q.limit ? ds.fmtBytes(q.limit) : '不限'}`);
        }
        for (const [kind, label, total] of [['image', '图片', est.images], ['video', '视频', est.videos]]) {
          const n = st => c[kind]?.[st]?.n || 0;
          console.log(`${label}：已上传 ${n('done')}（${ds.fmtBytes(c[kind]?.done?.bytes)}），等待 ${n('pending')}，失败 ${n('failed')}，跳过 ${n('skipped')}，库里约 ${total} 个`);
        }
      } else if (sub === 'sync') {
        const only = args.only === 'images' ? 'image' : args.only === 'videos' ? 'video' : '';
        await ds.runSync({ concurrency: Number(args.concurrency) || 3, limit: Number(args.limit) || 0, only, log: m => console.log(m) });
      } else {
        console.log('用法：drive status | drive sync [--limit N] [--only images|videos] [--concurrency 3]');
      }
      break;
    }

    case 'reverse-refine': {
      const { refineWithGenerated } = await import('./lib/reverse.mjs');
      if (typeof args.image !== 'string') throw new Error('用法：reverse-refine --id 反推记录编号 --image 生成结果图片');
      const r = await refineWithGenerated({
        id: args.id, imageSrc: args.image, lang: typeof args.lang === 'string' ? args.lang : '',
        hint: typeof args.hint === 'string' ? args.hint : '', allowLocal: true,
      });
      if (args.json) return out({ ...r, media: { ...r.media, frames: undefined } });
      console.log(`第 ${r.media.round} 轮修正（记录 #${r.id}，基于 #${r.media.refined_from}）\n`);
      console.log('【差异】');
      for (const d of r.result.review || []) console.log(`- ${d.aspect || ''}：原图 ${d.original || '-'}；生成 ${d.generated || '-'} → ${d.fix || ''}`);
      console.log(`\n【修正后的提示词】\n${r.result.prompt}\n`);
      if (r.result.negative) console.log(`【避免项】\n${r.result.negative}\n`);
      break;
    }

    case 'history':
      for (const g of store.listGenerations(Number(args.limit) || 10)) console.log(`#${g.id} ${g.created_at} ${g.category.code}｜${g.goal.slice(0, 40)}\n\t${g.prompt_snippet}`);
      break;

    case 'settings': {
      const patch = {};
      if (typeof args['base-url'] === 'string') patch.llm_base_url = args['base-url'];
      if (typeof args['api-key'] === 'string') patch.llm_api_key = args['api-key'];
      if (typeof args.model === 'string') patch.llm_model = args.model;
      if (typeof args['vision-model'] === 'string') patch.llm_vision_model = args['vision-model'];
      if (Object.keys(patch).length) store.setSettings(patch);
      const s = store.getSettings();
      out({ llm_base_url: s.llm_base_url || '', llm_model: s.llm_model || '', llm_vision_model: s.llm_vision_model || '', llm_api_key_set: !!s.llm_api_key });
      break;
    }

    default: console.log(`未知命令：${cmd}\n\n${HELP}`); process.exitCode = 1;
  }
}

if (!relaunchWithProxy()) main().catch(e => { console.error(`错误：${e.message}`); process.exitCode = 1; });
