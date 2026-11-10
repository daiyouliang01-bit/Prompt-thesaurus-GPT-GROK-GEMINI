// 收录南鸢《把摄影里的机位讲明白，写 AI 人像提示词就有思路了》里的示例提示词（图片只保存链接）
import * as store from '../lib/db.mjs';
import { classifyWithin } from '../lib/classify.mjs';

const URL = 'https://x.com/nanyuan0412/status/2099683245726355869';
const NOTE = '来源：南鸢 @nanyuan0412《把摄影里的机位讲明白，写 AI 人像提示词就有思路了》（X 文章）';
const img = id => `https://pbs.twimg.com/media/${id}?format=jpg&name=large`;

const CASES = [
  {
    title: '鞋履细节：锚点在脚部的平视取景',
    prompt: '以鞋和脚部为画面主体，相机与脚部中心同高，镜头水平正对鞋面，不向上仰拍人物；取景从小腿中部到地面。',
    image: img('HSOSVDKbcAABc3X'),
    tags: ['机位', '平视', '拍摄锚点', '鞋履特写', '取景范围', '避免仰拍变形'],
    analysis: '反直觉要点：相机贴地不等于低机位。以要拍的部位（脚部中心）为锚点，相机与它同高、镜头水平，仍是平视。直接写“低机位拍鞋”容易得到从地面仰看整个人的画面，腿被放大、脸被拉伸。',
  },
  {
    title: '广角全身：人物小、保留大量环境',
    prompt: '相机距人物约3米，使用广角视角，人物全身完整可见，人物在画面中占比较小，保留大量环境，不拉长四肢。',
    image: img('HSOSVpFaYAAItpw'),
    tags: ['机位', '广角', '全身', '远景', '环境人像', '人物占比'],
    analysis: '距离要和焦距、最终景别一起写。模型不会严格按米数计算，关键是写出结果：全身完整、人物占比小、保留环境；并用“不拉长四肢”限制广角变形。',
  },
  {
    title: '中长焦近景：脸部是画面主体',
    prompt: '相机距人物约1.8米，中长焦人像视角，胸部以上近景，脸部是画面主体，背景范围较小，避免广角贴脸变形。',
    image: img('HSOSWMya8AAv1UU'),
    tags: ['机位', '中长焦', '近景', '胸部以上', '脸部主体', '避免广角变形'],
    analysis: '可简化为“中长焦人像视角，胸部以上近景，脸部是画面主体，背景范围较小”，已经交代了取景效果，单张图不一定要写米数；做 AI 视频、需要描述推进或后撤时，距离和空间关系仍然重要。',
  },
  {
    title: '标准平视：脸部中心同高的正面近景',
    prompt: '相机与人物脸部中心同高，镜头水平正对鼻梁中部，不俯拍、不仰拍；胸部以上近景，保持自然的正面五官比例，避免广角贴脸变形。',
    image: img('HSOSXW6boAEFPrS'),
    tags: ['机位', '平视', '正面', '近景', '五官比例', '证件照', '职业形象照'],
    analysis: '只写“平视”，模型可能只让人物眼睛看向前方。写清相机高度（脸部中心）、镜头朝向（水平正对鼻梁中部）和景别，平视才真正落地。适合证件照、职业形象照和五官比例稳定的人像；想显高大有压迫感可改为低于脸部中心向上仰拍。',
  },
  {
    title: '克制伤感：情绪从脸上被看见',
    prompt: '我要让观众先看到人物克制的伤感。成年女性正面看向镜头，拍摄锚点为脸部中心；相机与脸部中心同高，镜头水平正对，采用胸部以上近景。眼眶微湿，嘴角放松，不大哭；背景为连续、低对比的深绿色灌木，不出现高饱和标牌、路人和杂乱道具，不让背景抢走脸部注意力。',
    image: img('HSOSY_3bMAAiibd'),
    tags: ['机位', '情绪人像', '克制伤感', '近景', '平视', '背景压制', '画面目标'],
    analysis: '完整套用机位公式：先写画面目标，再写方位、锚点、相机高度、镜头朝向、景别，最后写注意力限制。情绪出不来常是人物太小或背景抢戏，所以收到近景并压掉高饱和、杂乱的背景。',
  },
  {
    title: '人像机位检查清单与填空公式',
    prompt: `画面目标：观众第一眼应该看什么？
人物方位：正面、三分之二侧面、纯侧面，还是背面？
目标锚点：脸部、胸部、脚部、手部，还是某个道具？
相机高度：与锚点同高、高于锚点，还是低于锚点？
镜头朝向：水平正对、向下俯拍，还是向上仰拍？
景别：远景、全景、中景、近景，还是特写？
注意力限制：哪些背景、穿搭和道具不能抢戏？

填空公式：
我要让观众先看【目标】。人物为【方位】，拍摄锚点是【部位】；相机【与锚点同高／高于／低于】，镜头【水平正对／向下俯拍／向上仰拍】；采用【景别】，控制【背景和道具】不抢走注意力。`,
    image: img('HSOSUcbbsAASRWC'),
    tags: ['机位', '模板', '检查清单', '人像构图', '景别', '拍摄锚点'],
    analysis: '配图为反例：只写“低机位人像”得到的几张图，姿势、脸部朝向和取景都不统一。用这张清单排查人像问题：先判断出错的是高度、方位、镜头朝向还是景别，只改那一个变量，比加“高级电影感”更有用。',
  },
];

let added = 0;
for (const c of CASES) {
  const dup = store.findDuplicatePrompt(c.prompt);
  if (dup) { console.log(`已存在，跳过：#${dup.id} ${dup.title}`); continue; }
  const sub = classifyWithin('C01', { title: c.title, tags: c.tags, prompt: c.prompt })?.subcategory || null;
  const created = store.createCase({
    source: 'user', title: c.title, prompt: c.prompt, category_code: 'C01', subcategory: sub, subtype: '机位与景别写法',
    tags: c.tags, analysis: c.analysis, image_url: c.image, extra_images: '[]', media_type: 'image',
    source_url: URL, note: NOTE, classify_source: 'manual',
  });
  added++;
  console.log(`已加入 #${created.id} ${created.title}`);
}
console.log(`完成：新增 ${added} 条`);
