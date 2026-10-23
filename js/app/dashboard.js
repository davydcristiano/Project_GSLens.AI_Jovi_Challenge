/* GSLens.AI — js/app/dashboard.js
   Painel de estatísticas.
   Scripts clássicos carregados em ordem pelo index.html; compartilham o
   escopo global (estado em core.js). */
'use strict';

/* ══════════════════════════════════════
   DASHBOARD / ESTATÍSTICAS
══════════════════════════════════════ */
let dashFrom = 'home';
function openDashboard() {
  dashFrom = document.getElementById('cameraScreen').classList.contains('screen-hidden') ? 'home' : 'camera';
  showScreen('dashboardScreen');
  renderDashboard();
}

function closeDashboard() {
  dashCharts.forEach(c=>c.destroy()); dashCharts=[];
  if(dashFrom==='camera' && stream) showScreen('cameraScreen');
  else { hideAllScreens(); document.getElementById('homeScreen').style.display=''; }
}

function renderDashboard() {
  const body=document.getElementById('dashboardBody');
  dashCharts.forEach(c=>c.destroy()); dashCharts=[];
  const total=photos.length;
  const videos=photos.filter(p=>p.type==='video').length;

  const filterCounts={};
  photos.forEach(p=>{const k=p.filter||'none';filterCounts[k]=(filterCounts[k]||0)+1;});
  const topFilters=Object.entries(filterCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);

  const modeCounts={};
  photos.forEach(p=>{const k=MODE_NAMES[p.mode==='ar'?'efeitos':p.mode]||p.mode||'Foto';modeCounts[k]=(modeCounts[k]||0)+1;});

  /* CORREÇÃO: agrupava por dia da semana ("seg", "ter"...), somando fotos de
     semanas anteriores ao dia atual. Agora usa a data completa. */
  const days=[];
  const today=new Date(); today.setHours(0,0,0,0);
  for(let i=6;i>=0;i--){const d=new Date(today);d.setDate(d.getDate()-i);days.push({key:d.toDateString(),label:d.toLocaleDateString('pt-BR',{weekday:'short',day:'2-digit'}),n:0});}
  photos.forEach(p=>{const k=new Date(p.id).toDateString();const day=days.find(d=>d.key===k);if(day)day.n++;});

  body.innerHTML=`
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-num">${total}</div><div class="stat-lbl">Total de itens</div></div>
      <div class="stat-card"><div class="stat-num">${total-videos}</div><div class="stat-lbl">Fotos</div></div>
      <div class="stat-card"><div class="stat-num">${videos}</div><div class="stat-lbl">Vídeos</div></div>
      <div class="stat-card"><div class="stat-num">${Object.keys(filterCounts).filter(k=>k!=='none').length}</div><div class="stat-lbl">Filtros usados</div></div>
    </div>
    <div class="chart-card">
      <h4>📅 Capturas por dia (últimos 7 dias)</h4>
      <div class="chart-wrap"><canvas id="chartDays"></canvas></div>
    </div>
    <div class="chart-card">
      <h4>🎨 Filtros mais usados</h4>
      <div class="chart-wrap"><canvas id="chartFilters"></canvas></div>
    </div>
    <div class="chart-card">
      <h4>📷 Modos de captura</h4>
      <div class="chart-wrap"><canvas id="chartModes"></canvas></div>
    </div>
  `;

  /* CORREÇÃO: sem Chart.js (offline) a tela quebrava com ReferenceError */
  if(typeof window.Chart==='undefined'){
    const list=(title,entries)=>`<ul class="dash-list">${entries.map(([k,v])=>`<li><span>${k}</span><strong>${v}</strong></li>`).join('')||'<li><span>Sem dados</span></li>'}</ul>`;
    body.querySelectorAll('.chart-wrap')[0].outerHTML=list('',days.map(d=>[d.label,d.n]));
    body.querySelectorAll('.chart-wrap')[0].outerHTML=list('',topFilters);
    body.querySelectorAll('.chart-wrap')[0].outerHTML=list('',Object.entries(modeCounts));
    body.insertAdjacentHTML('beforeend','<p class="text-muted small">Gráficos indisponíveis (biblioteca de gráficos não carregou — verifique a conexão). Exibindo os dados em lista.</p>');
    return;
  }
  const txt=isDark?'#f0f0ff':'#1a1a2e', tick=isDark?'#8b93a7':'#444', gridc=isDark?'rgba(255,255,255,.06)':'rgba(0,0,0,.06)';
  const chartOpts={responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:txt,font:{size:11}}}}};
  try {
    dashCharts.push(new Chart(document.getElementById('chartDays'),{type:'bar',data:{labels:days.map(d=>d.label),datasets:[{label:'Capturas',data:days.map(d=>d.n),backgroundColor:'rgba(0,229,255,.6)',borderColor:'rgba(0,229,255,1)',borderWidth:1,borderRadius:4}]},options:{...chartOpts,scales:{y:{beginAtZero:true,ticks:{color:tick,precision:0},grid:{color:gridc}},x:{ticks:{color:tick},grid:{display:false}}}}}));
    dashCharts.push(new Chart(document.getElementById('chartFilters'),{type:'doughnut',data:{labels:topFilters.map(f=>f[0]==='none'?'original':f[0]),datasets:[{data:topFilters.map(f=>f[1]),backgroundColor:['rgba(0,229,255,.8)','rgba(245,166,35,.8)','rgba(50,215,75,.8)','rgba(255,69,58,.8)','rgba(160,100,255,.8)']}]},options:chartOpts}));
    dashCharts.push(new Chart(document.getElementById('chartModes'),{type:'polarArea',data:{labels:Object.keys(modeCounts),datasets:[{data:Object.values(modeCounts),backgroundColor:['rgba(0,229,255,.6)','rgba(245,166,35,.6)','rgba(50,215,75,.6)','rgba(255,69,58,.6)','rgba(10,132,255,.6)','rgba(160,100,255,.6)']}]},options:{...chartOpts,scales:{r:{ticks:{color:tick,backdropColor:'transparent',precision:0},grid:{color:gridc}}}}}));
  } catch(e){ console.error('Gráficos:',e); }
}
