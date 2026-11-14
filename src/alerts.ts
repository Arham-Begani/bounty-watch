import type { Alert, Config } from './types.ts';
import { Http } from './http.ts';
import { clip, hash, html, record, string } from './util.ts';
import { ingestCommand } from './triage.ts';
export interface Destination { id: string; kind: 'discord' | 'telegram' }
export function destinations(config: Config): Destination[] {
  const values: Destination[] = [];
  if (config.discordUrl) values.push({kind:'discord',id:hash('discord:' + config.discordUrl)});
  if (config.telegramToken) values.push({kind:'telegram',id:hash('telegram:' + config.telegramToken + ':' + config.telegramChatId)});
  return values;
}
function dollars(cents: number): string { return '$' + (cents / 100).toFixed(2); }
function md(text: string): string { return text.replace(/[\\`*_{}\[\]()#+.!|>~]/g, '\\$&'); }
export function discordMessage(alert: Alert, config: Config): unknown {
  const triage = alert.triage;
  const embed = {
    title:clip(alert.issue.repo + ' · ' + alert.issue.title,240), url:alert.issue.url,
    description:md(clip(triage.summary,600)), color:0x7c3aed,
    fields:[
      {name:'USD bounty',value:dollars(alert.bounty.cents),inline:true},
      {name:'Solvability / reproduction',value:`${triage.solvability}/10 · ${triage.reproductionClarity}/10 (overall ${triage.score}/10)`,inline:true},
      {name:'Tech stack',value:md(clip(alert.techStack.join(', '),450)) || 'Unknown'},
      ...triage.predictedFiles.map((file,index) => ({name:`Predicted file ${index+1} (hypothesis)`,value:md(file.path)+'\n'+md(clip(file.reason,120))})),
      {name:'Bounty evidence',value:md(clip(alert.bounty.evidence,220))+'\n'+alert.bounty.sourceUrl},
      {name:'Clone + ingest (POSIX shell)',value:'```sh\n'+ingestCommand(alert.issue.repo,alert.commit,config.repomixVersion)+'\n```'},
      {name:'Uncertainty',value:md(clip(triage.uncertainty,350))},
    ], footer:{text:'Textual bounty offer · predicted paths verified at commit '+alert.commit.slice(0,12)+' · '+alert.id.slice(0,12)},
  };
  for (const field of embed.fields) field.value = clip(field.value,1024);
  const size = () => embed.title.length + embed.description.length + embed.footer.text.length +
    embed.fields.reduce((total,field) => total + field.name.length + field.value.length,0);
  // Preserve exact file paths and the complete command. Trim explanatory text first.
  if(size()>6000)embed.description=clip(embed.description,Math.max(1,embed.description.length-(size()-6000)));
  for(const name of ['Uncertainty','Bounty evidence','Tech stack']) {
    const field=embed.fields.find(f=>f.name===name);
    if(field && size()>6000)field.value=clip(field.value,Math.max(32,field.value.length-(size()-6000)));
  }
  if(size()>6000)throw new Error('Discord embed exceeds its aggregate character budget');
  return {allowed_mentions:{parse:[]},embeds:[embed]};
}
export function telegramMessage(alert: Alert, config: Config): string {
  const t=alert.triage;
  return `<b>${html(alert.issue.repo)} · ${dollars(alert.bounty.cents)} USD</b>\n`+
    `<a href="${html(alert.issue.url)}">${html(clip(alert.issue.title,200))}</a>\n`+
    `Overall ${t.score}/10 · Solvability ${t.solvability}/10 · Reproduction ${t.reproductionClarity}/10\n\n`+
    html(clip(t.summary,400))+'\n\n<b>Tech stack</b>\n'+html(clip(alert.techStack.join(', '),300))+
    '\n\n<b>Predicted files (hypotheses)</b>\n'+t.predictedFiles.map(p=>'<code>'+html(p.path)+'</code> — '+html(clip(p.reason,80))).join('\n')+
    '\n\n<b>Clone + ingest (POSIX shell)</b>\n<pre>'+html(ingestCommand(alert.issue.repo,alert.commit,config.repomixVersion))+'</pre>\n'+
    '<b>Uncertainty</b> '+html(clip(t.uncertainty,250))+`\n<a href="${html(alert.bounty.sourceUrl)}">Bounty evidence</a> · ${alert.id.slice(0,12)}`;
}
export async function deliver(http: Http, config: Config, destination: Destination, alert: Alert): Promise<void> {
  if (destination.kind==='discord') {
    const url=new URL(config.discordUrl);url.searchParams.set('wait','true');
    const result=record(await http.json(url.toString(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(discordMessage(alert,config))},'discord'));
    if (!string(result['id'])) throw new Error('Discord message acknowledgement missing');
  } else {
    const result=record(await http.json(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        chat_id:config.telegramChatId,text:telegramMessage(alert,config),parse_mode:'HTML',link_preview_options:{is_disabled:true},
      }),
    },'telegram'));
    if (result['ok']!==true || typeof record(result['result'])['message_id']!=='number') throw new Error('Telegram message acknowledgement missing');
  }
}
