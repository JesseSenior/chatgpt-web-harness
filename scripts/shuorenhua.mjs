#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { canonical, sha256 } from './audit.mjs';
import { failure } from './protocol.mjs';

export const SHUORENHUA_SOURCE = Object.freeze({
  repository: 'https://github.com/MrGeDiao/shuorenhua',
  commit: '1a97697fb2b1744ea7850a12cf23b9c0aa7200a1',
  license: 'MIT'
});

export const SHUORENHUA_SEMANTIC_CHECKS = Object.freeze([
  {
    id: 'information-fidelity',
    text: 'Every fact, number, date, version, range, unit, condition, negation, and degree remains accurate.'
  },
  {
    id: 'protected-spans',
    text: 'Names, terms, quotations, commands, code, paths, fields, configuration, logs, errors, and metrics remain unchanged.'
  },
  {
    id: 'attribution-and-relations',
    text: 'The response preserves who did, said, owns, or is responsible for each action and does not change relationship direction or completion state.'
  },
  {
    id: 'unsourced-claims',
    text: 'Unsourced authority framing is removed, and no institution, study, year, metric, or conclusion was invented.'
  },
  {
    id: 'natural-style',
    text: 'The response states concrete information directly without ceremonial openings, empty summaries, inflated significance, business jargon, performative engineering language, or psychological judgments.'
  },
  {
    id: 'scope-contract',
    text: 'The edit follows chat/minimal scope: structural below 1000 language units and bounded at or above 1000 units.'
  },
  {
    id: 'send-ready',
    text: 'The response is one send-ready version and does not expose the rewrite or audit process.'
  }
]);

const CHINESE_TIER_1 = [
  {
    id: 'zh-opening-boilerplate',
    action: 'Remove the ceremonial opener and state the information directly.',
    terms: [
      '值得注意的是', '值得一提的是', '需要指出的是', '不可否认的是', '不难发现', '不容忽视',
      '众所周知', '让我们一起来看看', '接下来我将为你', '在当今社会', '不得不说', '诚然',
      '毫不夸张地说', '具体来说', '更重要的是'
    ]
  },
  {
    id: 'zh-inflated-significance',
    action: 'Replace significance claims with the concrete effect or evidence.',
    terms: [
      '毋庸置疑', '至关重要', '举足轻重', '令人瞩目', '令人惊叹', '意义非凡', '前所未有',
      '史无前例', '不可磨灭', '具有重要意义', '发挥着关键作用', '颠覆性变革', '范式转移',
      '值得深思', '令人深思', '发人深省'
    ]
  },
  {
    id: 'zh-business-jargon',
    action: 'Name the concrete actor, action, and result instead of using business jargon.',
    terms: [
      '降本增效', '底层逻辑', '顶层设计', '赋能生态', '赋能团队', '拉通链路', '形成闭环',
      '打造抓手', '颗粒度对齐', '心智占领', '场景化落地'
    ]
  },
  {
    id: 'zh-performative-engineering',
    action: 'Replace performative engineering language with the actual operation or result.',
    terms: [
      '稳稳兜住', '砍一刀', '打掉问题', '做一个更硬的排除法', '把差异收窄', '抓到的现象',
      '稳稳接住', '坐实了', '对上了', '锁住结论', '狠狠干', '补一刀', '说人话就是',
      '不靠猜', '不瞎猜'
    ]
  },
  {
    id: 'zh-self-media-template',
    action: 'Remove promotional template language and keep the useful information.',
    terms: [
      '保姆级教程', '保姆级攻略', '一文读懂', '万字长文', '建议收藏', '强烈推荐', '划重点',
      '绝绝子', '谁懂啊', '真的会谢', '未来可期', '让我们拭目以待'
    ]
  },
  {
    id: 'zh-summary-template',
    action: 'Delete the summary cue and state only the conclusion that adds information.',
    terms: [
      '综上所述', '总而言之', '总的来说', '总体来看', '由此可见', '简而言之', '归根结底',
      '不言而喻', '在此过程中', '在这个过程中', '由此可以看出', '一句话总结', '结论先说清楚'
    ]
  },
  {
    id: 'zh-sycophancy',
    action: 'Remove praise and respond to the specific content.',
    terms: [
      '好问题！', '你说得很对', '这是一个很好的观点', '让我来为你解释', '希望这对你有帮助',
      '如果你有其他问题', '你问到了问题的核心', '你的观察力太敏锐了', '这个思路简直绝了',
      '我必须很认真地说一句', '我要讲一个更深一点的东西'
    ]
  },
  {
    id: 'zh-proactive-upsell',
    action: 'Remove the offer or announcement and give only the requested result.',
    terms: [
      '我立马开始', '要不要我', '如果你愿意', '只要你回复我', '你一回复我就', '我先来',
      '顺手帮你', '我已确认'
    ]
  },
  {
    id: 'zh-psychological-judgment',
    action: 'Remove psychological judgment and respond only to information the user provided.',
    terms: [
      '你只是太久没被', '你不是敏感', '你不是想太多', '你不是矫情', '你太清醒了',
      '你太懂了', '你太对了', '这次我懂了，我真的懂了', '稳稳地接住你', '稳稳地接住所有人'
    ]
  },
  {
    id: 'zh-unsourced-authority',
    action: 'Provide a specific source or remove the claim that depends on unsourced authority.',
    terms: ['研究表明', '数据显示', '有专家指出', '业内人士认为', '据报道']
  }
];

const ENGLISH_TIER_1 = [
  {
    id: 'en-opening-boilerplate',
    action: 'Remove the throat-clearing opener and state the information directly.',
    terms: [
      "Here's the thing", 'The uncomfortable truth is', 'Can we talk about', "Let's be honest", "I'll be frank",
      "It's worth noting that", 'At the end of the day', "In today's world", 'In a world where',
      'What this means is', "It's important to note", 'It is important to note that'
    ]
  },
  {
    id: 'en-emphasis-crutch',
    action: 'Remove the emphasis cue and let the evidence carry the statement.',
    terms: ['Full stop', 'Let that sink in', 'Make no mistake', 'Mark my words', 'Read that again']
  },
  {
    id: 'en-business-jargon',
    action: 'Replace business jargon with the concrete action or result.',
    terms: [
      'game-changer', 'circle back', 'lean into', 'deep dive', 'thought leader', 'actionable insights',
      'holistic approach', 'unlock value', 'drive synergy', 'empower the ecosystem', 'paradigm shift'
    ]
  },
  {
    id: 'en-significance-inflation',
    action: 'Replace significance inflation with the concrete fact or effect.',
    terms: [
      'testament to', 'stands as a', 'serves as a', 'watershed moment', 'indelible mark', 'groundbreaking innovation',
      'cutting-edge solution', 'pivotal moment'
    ]
  },
  {
    id: 'en-filler',
    action: 'Use the direct, shorter statement.',
    terms: [
      'Due to the fact that', 'At this point in time', 'The system has the ability to', 'It goes without saying'
    ]
  },
  {
    id: 'en-sycophancy',
    action: 'Remove praise or meta commentary and answer directly.',
    terms: [
      'Great question', "You're absolutely right", 'I hope this helps', "Let me know if you'd like me to expand",
      'In this essay we will explore', "As we'll see"
    ]
  },
  {
    id: 'en-unsourced-authority',
    action: 'Provide a specific source or remove the claim that depends on unsourced authority.',
    terms: ['studies show', 'research shows', 'experts say', 'industry insiders believe', 'data shows']
  }
];

const CHINESE_TIER_2 = [
  '然而', '此外', '与此同时', '显著', '有效', '全面', '积极', '持续', '进一步', '充分',
  '恰恰', '正是', '无疑', '可谓', '堪称'
];

const ENGLISH_TIER_2 = [
  'harness', 'navigate', 'foster', 'elevate', 'unleash', 'resonate', 'revolutionize', 'underpin',
  'nuanced', 'crucial', 'multifaceted', 'myriad', 'plethora', 'encompass', 'transformative',
  'cornerstone', 'paramount', 'poised', 'burgeoning', 'nascent', 'quintessential', 'overarching'
];

const CHINESE_TIER_3 = ['重要', '关键', '核心', '创新', '优化', '提升', '推动', '确保', '实现', '促进'];
const ENGLISH_TIER_3 = [
  'significant', 'innovative', 'effective', 'dynamic', 'scalable', 'compelling', 'unprecedented',
  'exceptional', 'remarkable', 'sophisticated', 'instrumental', 'comprehensive', 'robust', 'seamless'
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phrasePattern(phrase, english = false) {
  const value = escapeRegExp(phrase);
  return english
    ? new RegExp(`(?<![A-Za-z0-9_])${value}(?![A-Za-z0-9_])`, 'giu')
    : new RegExp(value, 'gu');
}

function maskRange(characters, start, end) {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== '\n' && characters[index] !== '\r') characters[index] = ' ';
  }
}

function maskMatches(text, characters, pattern) {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) maskRange(characters, match.index, match.index + match[0].length);
}

function maskedNaturalLanguage(text) {
  const characters = text.split('');
  const patterns = [
    /```[\s\S]*?```|~~~[\s\S]*?~~~/g,
    /`[^`\n]+`/g,
    /^\s*>.*$/gm,
    /“[^”\n]*”|‘[^’\n]*’|"[^"\n]*"|(?<![A-Za-z])'[^'\n]+'(?![A-Za-z])/g,
    /\]\((?:https?:\/\/|[^)\s])+\)/gi,
    /\b(?:https?:\/\/|www\.)[^\s<>)]+/gi,
    /(?<![A-Za-z0-9_])(?:\.{1,2}\/|\/)[^\s<>"']+/g,
    /\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g,
    /^\s*(?:[$%]\s+|(?:npm|node|git|pnpm|yarn|curl|wget|python3?|bash|zsh)\s+).+$/gmi,
    /^\s*(?:\[[^\]\n]+\]\s*)?(?:ERROR|WARN|INFO|DEBUG|TRACE|HTTP\/\d|[A-Z][A-Za-z]+Error:)\b.*$/gmi
  ];
  for (const pattern of patterns) maskMatches(text, characters, pattern);
  return characters.join('');
}

function languageUnits(text) {
  const chinese = text.match(/\p{Script=Han}/gu)?.length || 0;
  const english = text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)?.length || 0;
  return chinese + english;
}

function location(text, index) {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const lineStart = before.lastIndexOf('\n') + 1;
  return { line, column: index - lineStart + 1 };
}

function excerpt(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const endIndex = text.indexOf('\n', index);
  const end = endIndex === -1 ? text.length : endIndex;
  const value = text.slice(start, end).trim();
  return value.length <= 180 ? value : `${value.slice(0, 177)}...`;
}

function violation(text, ruleId, index, action, extra = {}) {
  return { rule_id: ruleId, ...location(text, index), excerpt: excerpt(text, index), action, ...extra };
}

function phraseViolations(original, visible) {
  const violations = [];
  for (const group of CHINESE_TIER_1) {
    for (const term of group.terms) {
      for (const match of visible.matchAll(phrasePattern(term))) {
        violations.push(violation(original, group.id, match.index, group.action, { match: match[0] }));
      }
    }
  }
  for (const group of ENGLISH_TIER_1) {
    for (const term of group.terms) {
      for (const match of visible.matchAll(phrasePattern(term, true))) {
        violations.push(violation(original, group.id, match.index, group.action, { match: match[0] }));
      }
    }
  }
  return violations;
}

function paragraphRanges(text) {
  const ranges = [];
  const pattern = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g;
  for (const match of text.matchAll(pattern)) ranges.push({ start: match.index, text: match[0] });
  return ranges;
}

function termMatches(text, terms, english = false, offset = 0) {
  const matches = [];
  for (const term of terms) {
    for (const match of text.matchAll(phrasePattern(term, english))) {
      matches.push({ index: offset + match.index, term: match[0] });
    }
  }
  return matches.sort((left, right) => left.index - right.index);
}

function tierTwoViolations(original, visible) {
  const violations = [];
  for (const paragraph of paragraphRanges(visible)) {
    const units = languageUnits(paragraph.text);
    const matches = [
      ...termMatches(paragraph.text, CHINESE_TIER_2, false, paragraph.start),
      ...termMatches(paragraph.text, ENGLISH_TIER_2, true, paragraph.start)
    ].sort((left, right) => left.index - right.index);
    const threshold = units < 100 ? 2 : 3;
    if (matches.length < threshold) continue;
    const terms = [...new Set(matches.map(match => match.term))];
    violations.push(violation(
      original,
      'tier-2-density',
      matches[0].index,
      `Keep the most useful connector or modifier and rewrite the others: ${terms.join(', ')}.`,
      { count: matches.length }
    ));
  }
  return violations;
}

function tierThreeThreshold(units, count) {
  if (units < 200) return count >= 3;
  if (units <= 1000) return count >= 5;
  return count / units > 0.005;
}

function tierThreeViolations(original, visible, units) {
  const violations = [];
  for (const [terms, english] of [[CHINESE_TIER_3, false], [ENGLISH_TIER_3, true]]) {
    for (const term of terms) {
      const matches = termMatches(visible, [term], english);
      if (!tierThreeThreshold(units, matches.length)) continue;
      violations.push(violation(
        original,
        'tier-3-density',
        matches[0].index,
        `Reduce repeated '${term}' modifiers or replace them with concrete information.`,
        { match: term, count: matches.length }
      ));
    }
  }
  return violations;
}

function structuralViolations(original, visible, units) {
  const violations = [];
  const rhetoricalPatterns = [
    /如果我告诉你[^？?\n]{0,160}[？?]/gu,
    /(?<![A-Za-z0-9_])What if I told you\b[^?\n]{0,220}\?/giu
  ];
  for (const pattern of rhetoricalPatterns) {
    for (const match of visible.matchAll(pattern)) {
      violations.push(violation(
        original,
        'rhetorical-hook',
        match.index,
        'Remove the rhetorical hook and state the supported claim directly.',
        { match: match[0] }
      ));
    }
  }

  const inflationPatterns = [
    /这不(?:仅|仅仅)是[^。！？\n]{1,120}更是[^。！？\n]{1,160}/gu,
    /(?<![A-Za-z0-9_])This (?:is not|isn't) just\b[^.!?\n]{1,180}\b(?:it is|it's)\b[^.!?\n]{1,180}/giu
  ];
  for (const pattern of inflationPatterns) {
    for (const match of visible.matchAll(pattern)) {
      violations.push(violation(
        original,
        'value-inflation-contrast',
        match.index,
        'Remove the value-inflation frame and keep the factual relationship.',
        { match: match[0] }
      ));
    }
  }

  const contrastPatterns = [
    /(?:不是|不像)[^。！？\n]{1,100}(?:而是|更像)[^。！？\n]{1,120}/gu,
    /(?<![A-Za-z0-9_])(?:it|this|that|they|we|you)?\s*(?:is|are|'s|'re)?\s*not\b[^.!?\n]{1,160}\b(?:but|rather)\b[^.!?\n]{1,180}/giu
  ];
  const contrasts = contrastPatterns.flatMap(pattern => [...visible.matchAll(pattern)].map(match => ({
    index: match.index,
    text: match[0]
  }))).sort((left, right) => left.index - right.index);
  const globalThreshold = units < 300 ? 2 : units <= 1000 ? 3 : Math.ceil(units / 300);
  if (contrasts.length >= globalThreshold) {
    violations.push(violation(
      original,
      'binary-contrast-density',
      contrasts[0].index,
      'Replace repeated false contrasts with direct statements while preserving both meaningful sides.',
      { count: contrasts.length }
    ));
  }
  return violations;
}

function deduplicate(violations) {
  const seen = new Set();
  return violations.filter(item => {
    const key = `${item.rule_id}:${item.line}:${item.column}:${item.match || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => left.line - right.line || left.column - right.column || left.rule_id.localeCompare(right.rule_id));
}

export function auditShuorenhua(content) {
  const original = String(content || '');
  const visible = maskedNaturalLanguage(original);
  const units = languageUnits(visible);
  const scope = units >= 1000 ? 'bounded' : 'structural';
  const violations = deduplicate([
    ...phraseViolations(original, visible),
    ...tierTwoViolations(original, visible),
    ...tierThreeViolations(original, visible, units),
    ...structuralViolations(original, visible, units)
  ]);
  const result = {
    pass: violations.length === 0,
    profile: 'chat',
    level: 'minimal',
    scope,
    unsourced_mode: 'rewrite-safe',
    language_units: units,
    source_commit: SHUORENHUA_SOURCE.commit,
    content_sha256: sha256(original),
    semantic_checks: SHUORENHUA_SEMANTIC_CHECKS,
    violations
  };
  result.audit_sha256 = sha256(canonical(result));
  return result;
}

function parseInput() {
  const argument = process.argv[3];
  if (argument) return JSON.parse(argument);
  const input = fs.readFileSync(0, 'utf8').trim();
  return input ? JSON.parse(input) : {};
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  if (process.argv[2] !== 'audit') {
    emit(failure('BAD_USAGE'));
    process.exitCode = 1;
    return;
  }
  try {
    const input = parseInput();
    if (!String(input.content || '').trim()) {
      emit(failure('BAD_INPUT', { missing: ['content'] }));
      process.exitCode = 1;
      return;
    }
    const audit = auditShuorenhua(input.content);
    if (!audit.pass) {
      emit(failure('SHUORENHUA_FAILED', {
        violations: audit.violations,
        detail: 'Revise every reported violation and run the audit again.'
      }));
      process.exitCode = 1;
      return;
    }
    emit({ ok: true, audit });
  } catch (error) {
    emit(failure('RUNTIME_ERROR', { detail: error.message }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
