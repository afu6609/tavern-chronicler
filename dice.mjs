import crypto from 'node:crypto';

export const DICE_TOOL_DESCRIPTION = '真随机掷骰。仅在剧情确实需要骰点（属性/技能检定、攻击、伤害、先攻、随机表等）时调用，formula 形如 1d20+5、2d6、d100。必须以返回的结果为准叙述成败，不得自行虚构点数。';

export const DICE_SERVER_INSTRUCTIONS = [
  '这是 SillyTavern 桥的真随机骰子服务器，唯一工具是 roll。',
  '所有出现在回复中的骰点都必须来自 roll 的返回结果；需要多个骰式时逐个或并行调用。',
  '不得挑选、重掷或修改结果；优势/劣势请用 2d20 后按规则取高/取低。',
  '纯叙事、不涉及检定时不要调用。',
].join('');

// 解析并投掷 NdM+K（1≤N≤100，2≤M≤1000）。randomInt 参数只用于确定性测试；
// 生产环境始终使用 Node crypto.randomInt。
export function rollFormula(formula, randomInt = crypto.randomInt) {
  const m = String(formula).trim().match(/^(\d{0,3})[dD](\d{1,4})\s*([+-]\s*\d{1,4})?$/);
  if (!m) throw new Error(`无法解析骰式: ${formula}（支持 NdM+K，如 1d20+5、2d6、d100）`);
  const n = Math.min(Math.max(Number(m[1] || 1), 1), 100);
  const faces = Math.min(Math.max(Number(m[2]), 2), 1000);
  const mod = m[3] ? Number(m[3].replace(/\s/g, '')) : 0;
  const rolls = Array.from({ length: n }, () => randomInt(1, faces + 1));
  const total = rolls.reduce((a, b) => a + b, 0) + mod;
  const modText = mod ? (mod > 0 ? ` +${mod}` : ` ${mod}`) : '';
  return { total, rolls, formula: `${n}d${faces}${modText}`, text: `${n}d${faces}${modText} = [${rolls.join(', ')}]${modText} = ${total}` };
}
