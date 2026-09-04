// commands/history.js
// 최근 30분 일치율 그래프 명령어 (w!history [구역], 별칭 w!h)
//
// zoneHistory는 services/monitor.js가 관리하는 공유 상태입니다. index.js에서
// 이미 만들어진 "단 하나의" zoneHistory 객체를 deps로 주입받아야 checkZones()가
// 기록한 데이터를 그대로 조회할 수 있습니다 (이 파일에서 monitor.js를 다시
// require하면 checkZones()가 기록한 데이터와 별개의 빈 객체를 보게 됩니다).
//
// chartJSNodeCanvas(그래프 렌더러)는 다른 곳과 상태를 공유할 필요가 없는
// 단순 렌더링 도구라, 이 파일 안에서 직접 만들어 씁니다. 폰트 등록(registerFont)은
// index.js가 부팅 시 한 번 처리하므로, 이 파일이 require되는 시점(=index.js가
// 이미 폰트를 등록한 이후)에는 문제없이 등록된 폰트를 사용할 수 있습니다.

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { findZone } = require('../utils/helpers');

const chartJSNodeCanvas = new ChartJSNodeCanvas({
    width: 1600,
    height: 800,
    chartCallback: (ChartJS) => {
        ChartJS.defaults.font.family = 'GyeonggiTitle';
        ChartJS.defaults.font.size = 16;
    }
});

module.exports = (deps) => async (message, args) => {
    const { zoneHistory } = deps;

    const zoneName = args.join(' ');
    if (!zoneName) return message.reply('❌ 확인할 구역 이름을 입력해주세요. (예: w!history 독도)');

    const zone = findZone(zoneName);
    if (!zone) return message.reply(`❌ '${zoneName}' 구역을 찾을 수 없습니다.`);

    // 쌓인 모든 데이터 가져오기 (최대 최근 60개)
    const history = (zoneHistory[zone.name] || []).slice(-60);

    try {
        const configuration = {
            type: 'line',
            data: {
                labels: history.map(h => new Date(h.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Seoul' })),
                datasets: [{
                    label: '일치율 (%)',
                    data: history.map(h => h.percentage),
                    borderColor: 'rgb(54, 162, 235)',
                    backgroundColor: 'rgba(54, 162, 235, 0.3)',
                    borderWidth: 3,
                    pointRadius: 5,
                    pointBackgroundColor: 'rgb(54, 162, 235)',
                    pointBorderColor: '#fff',
                    pointBorderWidth: 2,
                    tension: 0.4,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    title: {
                        display: true,
                        text: `${zone.name} - 일치율 변화`,
                        font: { size: 36, weight: 'bold' },
                        color: '#333'
                    },
                    legend: {
                        display: true,
                        labels: {
                            color: '#333',
                            font: { size: 28 }
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: false,
                        min: Math.max(0, Math.floor(Math.min(...history.map(h => h.percentage)) - 5)),
                        max: 100,
                        ticks: {
                            color: '#666',
                            stepSize: 0.5,
                            callback: function(value) {
                                return value.toFixed(1) + '%';
                            }
                        },
                        grid: {
                            color: 'rgba(0, 0, 0, 0.1)',
                            drawBorder: true
                        },
                        title: {
                            display: true,
                            text: '일치율 (%)',
                            color: '#333',
                            font: { size: 30 }
                        }
                    },
                    x: {
                        ticks: {
                            color: '#666'
                        },
                        grid: {
                            color: 'rgba(0, 0, 0, 0.1)',
                            drawBorder: true
                        },
                        title: {
                            display: true,
                            text: '시간',
                            color: '#333',
                            font: { size: 30 }
                        }
                    }
                },
                backgroundColor: '#FFFFFF'
            },
            plugins: [{
                id: 'customCanvasBackgroundColor',
                beforeDraw: (chart) => {
                    const ctx = chart.canvas.getContext('2d');
                    ctx.save();
                    ctx.globalCompositeOperation = 'destination-over';
                    ctx.fillStyle = '#FFFFFF';
                    ctx.fillRect(0, 0, chart.width, chart.height);
                    ctx.restore();
                }
            }]
        };

        const imageBuffer = await chartJSNodeCanvas.renderToBuffer(configuration);
        const attachment = new AttachmentBuilder(imageBuffer, { name: 'history.png' });

        const embed = new EmbedBuilder()
            .setTitle(`📊 ${zone.name} 일치율 변화`)
            .setDescription(`최근 30분간의 일치율 변화 그래프입니다.`)
            .setColor(0x00AE86)
            .setImage('attachment://history.png')
            .addFields(
                { name: '데이터 포인트', value: `${history.length}개`, inline: true },
                { name: '최고 일치율', value: `${Math.max(...history.map(h => h.percentage)).toFixed(2)}%`, inline: true },
                { name: '최저 일치율', value: `${Math.min(...history.map(h => h.percentage)).toFixed(2)}%`, inline: true }
            )
            .setTimestamp();

        await message.reply({ embeds: [embed], files: [attachment] });
    } catch (error) {
        console.error('그래프 생성 오류:', error);
        message.reply('❌ 그래프 생성 중 오류가 발생했습니다.');
    }
};
