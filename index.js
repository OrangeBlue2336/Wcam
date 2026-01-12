require('dotenv').config();

const express = require('express');
const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const axios = require('axios');
const sharp = require('sharp');
const pixelmatch = require('pixelmatch').default || require('pixelmatch');
const { PNG } = require('pngjs');
const fs = require('fs');
const mongoose = require('mongoose');

// ========================================
// 1. 환경 변수 설정 (Render에서 설정할 것들)
// ========================================
const MONGODB_URI = process.env.MONGODB_URI || '';
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const RENDER_URL = process.env.RENDER_URL || '';
const NODE_ENV = process.env.NODE_ENV || 'production';

// 개발 모드 확인
const IS_DEV = NODE_ENV === 'development';
if (IS_DEV) {
    console.log('🔧 개발 모드로 실행 중...');
} else {
    console.log('🚀 프로덕션 모드로 실행 중...');
}

// 환경변수 확인 (보안상 전체는 표시하지 않음)
if (!MONGODB_URI || !BOT_TOKEN) {
    console.error('❌ 필수 환경변수가 설정되지 않았습니다!');
    console.error('MONGODB_URI:', MONGODB_URI ? '✅ 설정됨' : '❌ 없음');
    console.error('BOT_TOKEN:', BOT_TOKEN ? '✅ 설정됨' : '❌ 없음');
    process.exit(1);
}

// ========================================
// 2. MongoDB 연결 및 스키마 정의
// ========================================
mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ MongoDB 연결 성공!'))
    .catch(err => console.error('❌ MongoDB 연결 실패:', err));

// 서버별 설정을 저장하는 스키마
const SettingSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    channelId: String,
    roleId: String,
    cooldownTime: { type: Number, default: 600000 }, // 기본 10분
    enabled: { type: Boolean, default: true },
    threshold: { type: Number, default: 90 }, // 기본 90%
});

const Setting = mongoose.model('Setting', SettingSchema);

// 마지막 알림 시간을 메모리에 저장 (서버별, 구역별)
const lastAlertTime = {}; // 형식: { "guildId-zoneName": timestamp }

// ========================================
// 3. Express 웹서버 (Keep-alive용)
// ========================================
const app = express();
app.get('/', (req, res) => res.send('Wplace Bot is Running!'));
app.listen(process.env.PORT || 3000, () => console.log('🌐 Keep-alive 서버 실행 중'));

// 10분마다 자기 자신에게 요청 보내기 (Render 무료 플랜 슬립 방지)
setInterval(() => {
    axios.get(RENDER_URL).catch(err => console.log('Keep-alive 오류:', err.message));
}, 1000 * 60 * 10);

// ========================================
// 4. 디스코드 봇 클라이언트 생성
// ========================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ========================================
// 5. 감시 구역 설정
// ========================================
const monitorZones = [
    {
        name: "독도 태극기",
        tileUrl: "https://backend.wplace.live/files/s0/tiles/1774/795.png",
        originalPath: "./assets/ref_dokdo.png",
        x: 40, y: 100, width: 361, height: 261,
        wplaceUrl: "https://wplace.live/?lat=37.26901731348799&lng=131.8750484967773&zoom=12.532754498466533"
    },
    {
        name: "서울 태극기",
        tileUrl: "https://backend.wplace.live/files/s0/tiles/1746/793.png",
        originalPath: "./assets/ref_seoul.png",
        x: 420, y: 691, width: 160, height: 120,
        wplaceUrl: "https://wplace.live/?lat=37.47464909223321&lng=127.00204068427732&zoom=13.744052003011783"
    }
];

// ========================================
// 6. 유틸리티 함수
// ========================================
function parseDuration(duration) {
    const match = duration.match(/^(\d+)([smh])$/);
    if (!match) return null;
    const value = parseInt(match[1]);
    const unit = match[2];
    switch (unit) {
        case 's': return value * 1000;
        case 'm': return value * 1000 * 60;
        case 'h': return value * 1000 * 60 * 60;
        default: return null;
    }
}

// ========================================
// 7. 명령어 시스템
// ========================================
const commands = {
    'ping': async (message) => {
        const sent = await message.reply('퐁! 측정 중...');
        sent.edit(`퐁! 지연 시간: ${sent.createdTimestamp - message.createdTimestamp}ms`);
    },

    'setchannel': async (message, args) => {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('❌ 관리자 권한이 필요합니다.');
        }
        const channelId = args[0]?.replace(/[<#>]/g, '');
        if (!channelId) return message.reply('❌ 채널 ID나 멘션을 입력해주세요. (예: w!setchannel #알림채널)');

        const channel = message.guild.channels.cache.get(channelId);
        if (!channel) {
            return message.reply('❌ 해당 채널을 찾을 수 없습니다. 올바른 채널을 입력해주세요.');
        }
        if (!channel.isTextBased()) {
        return message.reply('❌ 텍스트 채널만 설정할 수 있습니다.');
        }

        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { channelId: channelId },
            { upsert: true }
        );

        message.reply(`✅ 알림 채널이 <#${channelId}>(으)로 설정되었습니다.`);
    },

    'setrole': async (message, args) => {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('❌ 관리자 권한이 필요합니다.');
        }
        const roleId = args[0]?.replace(/[<@&>]/g, '');
        if (!roleId) return message.reply('❌ 역할 ID나 멘션을 입력해주세요. (예: w!setrole @인증됨)');

        const role = message.guild.roles.cache.get(roleId);
        if (!role) {
            return message.reply('❌ 해당 역할을 찾을 수 없습니다. 올바른 역할을 입력해주세요.');
        }

        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { roleId: roleId },
            { upsert: true }
        );

        message.reply(`✅ 알림 역할이 ${role ? role.name : roleId}(으)로 설정되었습니다.`);
    },

    'setcooldown': async (message, args) => {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('❌ 관리자 권한이 필요합니다.');
        }

        if (!args[0]) {
            return message.reply('❌ 시간을 입력해주세요. (예: 10m, 1h, 30s)');
        }
    
        const duration = args[0];
        const ms = parseDuration(duration);
        if (!ms) return message.reply('❌ 시간 형식 오류입니다. (예: 10m, 1h, 30s)');

        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { cooldownTime: ms },
            { upsert: true }
        );

        message.reply(`✅ 알림 쿨다운이 ${duration}(으)로 설정되었습니다.`);
    },

    'setthreshold': async (message, args) => {
    if (!message.member.permissions.has('Administrator')) {
        return message.reply('❌ 관리자 권한이 필요합니다.');
    }

    if (!args[0]) {
        return message.reply('❌ 임계값을 입력해주세요. (예: w!setthreshold 85)');
    }

    const thresholdValue = parseFloat(args[0]);
    
    // 숫자 유효성 검사
    if (isNaN(thresholdValue)) {
        return message.reply('❌ 올바른 숫자를 입력해주세요. (예: w!setthreshold 85)');
    }

    // 범위 검사 (0~100)
    if (thresholdValue < 0 || thresholdValue > 100) {
        return message.reply('❌ 임계값은 0에서 100 사이의 값이어야 합니다.');
    }

    await Setting.findOneAndUpdate(
        { guildId: message.guild.id },
        { threshold: thresholdValue },
        { upsert: true }
    );

    message.reply(`✅ 태극기 훼손 감지 임계값이 **${thresholdValue}%**로 설정되었습니다.\n(일치율이 이 값보다 낮아지면 알림이 전송됩니다.)`);
},

    'status': async (message) => {
        const setting = await Setting.findOne({ guildId: message.guild.id });
        const serverThreshold = setting?.threshold || 90;
        
        let statusMsg = "**📊 현재 봇 상태**\n\n";
        statusMsg += "**감시 중인 구역:**\n";
        monitorZones.forEach(z => statusMsg += `• ${z.name}\n`);
        
        statusMsg += "\n**서버 설정:**\n";
        if (setting) {
            statusMsg += `• 감시 상태: ${setting.enabled ? '✅ 활성화' : '⏸️ 일시 정지'}\n`;
            statusMsg += `• 알림 채널: ${setting.channelId ? `<#${setting.channelId}>` : '미설정'}\n`;
            const role = setting.roleId ? message.guild.roles.cache.get(setting.roleId) : null;
            statusMsg += `• 알림 역할: ${role ? role.name : (setting.roleId ? setting.roleId : '미설정')}\n`;
            statusMsg += `• 쿨다운: ${setting.cooldownTime / 60000}분\n`;
            statusMsg += `• 임계값: ${setting.threshold}% (일치율이 이보다 낮으면 알림)\n`;
        } else {
            statusMsg += "아직 설정되지 않았습니다. `w!setchannel`과 `w!setrole`로 설정해주세요.";
        }

        message.reply(statusMsg);
    },

    'flag': async (message, args) => {
        const zoneName = args.join(' ');
        if (!zoneName) return message.reply('❌ 확인할 구역 이름을 입력해주세요. (예: w!flag 독도)');

        const zone = monitorZones.find(z => z.name.includes(zoneName));
        if (!zone) return message.reply(`❌ '${zoneName}' 구역을 찾을 수 없습니다.`);

        const statusMsg = await message.reply(`🔍 ${zone.name}의 실시간 이미지를 분석 중입니다...`);

        try {
            const response = await axios.get(zone.tileUrl, { responseType: 'arraybuffer' });
            const currentFlagBuffer = await sharp(Buffer.from(response.data))
                .extract({ left: zone.x, top: zone.y, width: zone.width, height: zone.height })
                .ensureAlpha()
                .toBuffer();

            const currentImg = PNG.sync.read(currentFlagBuffer);
            const originalImg = PNG.sync.read(fs.readFileSync(zone.originalPath));
            const { width, height } = originalImg;
            const diff = new PNG({ width, height });

            const numDiffPixels = pixelmatch(
                originalImg.data, currentImg.data, diff.data, width, height,
                { threshold: 0.1 }
            );

            const totalPixels = width * height;
            const matchPercentage = ((totalPixels - numDiffPixels) / totalPixels) * 100;

            const setting = await Setting.findOne({ guildId: message.guild.id });
            const serverThreshold = setting?.threshold || 90;

            const attachment = new AttachmentBuilder(currentFlagBuffer, { name: 'current_flag.png' });
            const matchPixels = totalPixels - numDiffPixels;
            const embed = new EmbedBuilder()
                .setTitle(`🖼️ 실시간 감시 화면: ${zone.name}`)
                .setURL(zone.wplaceUrl)
                .addFields(
                    { name: '현재 일치율', value: `**${matchPercentage.toFixed(2)}%**`, inline: true },
                    { name: '감시 기준', value: `${serverThreshold}%`, inline: true },
                    { name: '픽셀 정보', value: `일치: ${matchPixels.toLocaleString()}/${totalPixels.toLocaleString()}\n불일치: ${numDiffPixels.toLocaleString()}개`, inline: false }
                )
                .setDescription(
                    matchPercentage < serverThreshold
                        ? "⚠️ **주의: 현재 태극기가 훼손되었을 가능성이 있습니다!**"
                        : "✅ 현재 태극기 상태가 양호합니다."
                )
                .setColor(matchPercentage < serverThreshold ? 0xFF0000 : 0x00FF00)
                .setImage('attachment://current_flag.png')
                .setTimestamp();

            await statusMsg.delete();
            message.channel.send({ embeds: [embed], files: [attachment] });
        } catch (error) {
            console.error(error);
            message.reply('❌ 이미지 분석 중 오류가 발생했습니다.');
        }
    },

    'testalert': async (message, args) => {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('❌ 관리자 권한이 필요합니다.');
        }

        const zoneName = args.join(' ') || "독도 태극기";
        const zone = monitorZones.find(z => z.name.includes(zoneName));
        if (!zone) return message.reply('❌ 테스트할 구역을 찾을 수 없습니다.');

        message.reply(`🔔 [테스트] ${zone.name} 구역의 강제 알림 테스트를 시작합니다...`);

        try {
            const response = await axios.get(zone.tileUrl, { responseType: 'arraybuffer' });
            const currentFlagBuffer = await sharp(Buffer.from(response.data))
                .extract({ left: zone.x, top: zone.y, width: zone.width, height: zone.height })
                .toBuffer();

            const testTotalPixels = zone.width * zone.height;
            const setting = await Setting.findOne({ guildId: message.guild.id });
            const serverThreshold = setting?.threshold || 90;

            await sendAlert(zone, 0.00, currentFlagBuffer, message.guild.id, 0, testTotalPixels, testTotalPixels, serverThreshold);
            message.channel.send('✅ 테스트 알림이 전송되었습니다.');
        } catch (error) {
            console.error(error);
            message.reply('❌ 테스트 알림 전송 중 오류가 발생했습니다.');
        }
    },

    'resetcooldown': async (message, args) => {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('❌ 관리자 권한이 필요합니다.');
        }

        const zoneName = args.join(' ');
        if (!zoneName) {
            // 해당 서버의 모든 구역 쿨다운 초기화
            for (const key in lastAlertTime) {
                if (key.startsWith(message.guild.id)) {
                    delete lastAlertTime[key];
                }
            }
            return message.reply('✅ 이 서버의 모든 구역 알림 쿨다운이 초기화되었습니다.');
        }

        const zone = monitorZones.find(z => z.name.includes(zoneName));
        if (!zone) return message.reply(`❌ '${zoneName}' 구역을 찾을 수 없습니다.`);

        delete lastAlertTime[`${message.guild.id}-${zone.name}`];
        message.reply(`✅ ${zone.name}의 알림 쿨다운이 초기화되었습니다.`);
    },

    'help': async (message) => {
        const embed = new EmbedBuilder()
            .setTitle('📋 Wcam 명령어 목록')
            .setColor(0x0099FF)
            .addFields(
                { name: 'w!ping', value: '봇의 응답 속도를 확인합니다.' },
                { name: 'w!setchannel #채널', value: '[관리자] 알림을 받을 채널을 설정합니다.' },
                { name: 'w!setrole @역할', value: '[관리자] 알림 시 멘션할 역할을 설정합니다.' },
                { name: 'w!setcooldown [시간]', value: '[관리자] 알림 쿨다운 시간을 설정합니다. (예: 10m, 1h)' },
                { name: 'w!setthreshold [값]', value: '[관리자] 태극기 훼손 감지 임계값을 설정합니다. 설정하지 않을시 기본값은 90%이며, 완전한 일장기가 되는 시점인 83% 이하로 내리는것은 권장하지 않습니다. (예: w!setthreshold 85)' },
                { name: 'w!resetcooldown [지역]', value: '[관리자] 해당 지역 또는 전체 알림 쿨다운을 초기화합니다.' },
                { name: 'w!pause [시간]', value: '[관리자] 감시를 일시 정지합니다. (예: w!pause 30m, w!pause 1h)' },
                { name: 'w!resume', value: '[관리자] 감시를 재개합니다.' },
                { name: 'w!testalert [지역]', value: '[관리자] 테스트 알림을 전송합니다. (주의: 실제 역할 알림이 전송됩니다.)' },
                { name: 'w!status', value: '현재 봇의 상태와 설정을 확인합니다.' },
                { name: 'w!flag [지역]', value: '특정 구역 (독도, 서울)의 실시간 상태를 확인합니다.' },
                { name: 'w!help', value: '이 도움말을 표시합니다.' },
                { name: 'w!mambo', value: '???'}
            )
            .setTimestamp();

        message.reply({ embeds: [embed] });
    },

    'pause': async (message, args) => {
        if (!message.member.permissions.has('Administrator')) {
        return message.reply('❌ 관리자 권한이 필요합니다.');
    }
    
    const duration = args[0];
    const ms = duration ? parseDuration(duration) : null;

    if (duration && !ms) {
        return message.reply('❌ 시간 형식 오류입니다. (예: 30m, 1h) 또는 시간 없이 입력하면 무기한 정지됩니다.');
    }
    
    if (!ms) {
        // 기간 없이 실행 시 무기한 정지
        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { enabled: false },
            { upsert: true }
        );
        return message.reply('⏸️ 이 서버의 태극기 감시가 **무기한 정지**되었습니다.\n재개하려면 `w!resume`을 입력하세요.');
    } else {
        // 기간 지정 시 자동 재개
        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { enabled: false },
            { upsert: true }
        );
        
        message.reply(`⏸️ 이 서버의 태극기 감시가 **${duration}** 동안 정지되었습니다.\n수동으로 재개하려면 \`w!resume\`을 입력하세요.`);
        
        // 자동 재개 타이머 설정
        setTimeout(async () => {
            const setting = await Setting.findOne({ guildId: message.guild.id });
            if (setting && !setting.enabled) {
                await Setting.findOneAndUpdate(
                    { guildId: message.guild.id },
                    { enabled: true }
                );
                
                // 알림 채널에 자동 재개 메시지 전송
                if (setting.channelId) {
                    try {
                        const channel = await client.channels.fetch(setting.channelId);
                        if (channel) {
                            const embed = new EmbedBuilder()
                                .setTitle('▶️ 감시 자동 재개')
                                .setDescription('일시 정지 기간이 만료되어 태극기 감시가 자동으로 재개되었습니다.')
                                .setColor(0x00FF00)
                                .setTimestamp();
                            channel.send({ embeds: [embed] });
                        }
                    } catch (e) {
                        console.error('자동 재개 알림 전송 실패:', e);
                    }
                }
            }
        }, ms);
    }
},

    'resume': async (message, args) => {
        if (!message.member.permissions.has('Administrator')) {
        return message.reply('❌ 관리자 권한이 필요합니다.');
    }
    
    const setting = await Setting.findOne({ guildId: message.guild.id });
    
    if (!setting || setting.enabled) {
        return message.reply('⚠️ 현재 감시가 이미 활성화되어 있습니다.');
    }
    
    await Setting.findOneAndUpdate(
        { guildId: message.guild.id },
        { enabled: true }
    );
    
    message.reply('▶️ 태극기 감시가 **재개**되었습니다!');
},

'mambo': async (message) => {
    try {
        // 맘보 이모지 전송
        const mamboMsg = await message.channel.send('<:mambo:1459544557502070810>');
        
        // 1초 후 삭제
        setTimeout(async () => {
            try {
                await mamboMsg.delete();
            } catch (error) {
                console.log('맘보 메시지 삭제 실패:', error.message);
            }
        }, 1000);

    } catch (error) {
        console.error('mambo 명령어 오류:', error);
    }
},
        
};

// ========================================
// 8. 핵심 감시 로직
// ========================================
async function checkZones() {
    for (const zone of monitorZones) {
        try {
            if (!fs.existsSync(zone.originalPath)) {
                console.warn(`⚠️ ${zone.name}의 원본 이미지가 없습니다: ${zone.originalPath}`);
                continue;
            }

            // 현재 타일 다운로드 및 구간 추출
            const response = await axios.get(zone.tileUrl, { responseType: 'arraybuffer' });
            const currentFlagBuffer = await sharp(Buffer.from(response.data))
                .extract({ left: zone.x, top: zone.y, width: zone.width, height: zone.height })
                .ensureAlpha()
                .toBuffer();

            // 픽셀 비교
            const currentImg = PNG.sync.read(currentFlagBuffer);
            const originalImg = PNG.sync.read(fs.readFileSync(zone.originalPath));
            const { width, height } = originalImg;
            const diff = new PNG({ width, height });

            const numDiffPixels = pixelmatch(
                originalImg.data, currentImg.data, diff.data, width, height,
                { threshold: 0.1 }
            );

            const totalPixels = width * height;
            const matchPercentage = ((totalPixels - numDiffPixels) / totalPixels) * 100;

            console.log(`[${zone.name}] 일치율: ${matchPercentage.toFixed(2)}%`);

            // 모든 활성화된 서버에 대해 각각의 임계값 체크
            const allSettings = await Setting.find({ enabled: true });

            for (const setting of allSettings) {
                if (!setting.channelId) continue; // 채널 미설정 서버는 스킵

                // 서버별 임계값 (기본값: 90)
                const serverThreshold = setting.threshold || 90;

                // 해당 서버의 임계값 미만일 경우에만 알림
                if (matchPercentage < serverThreshold) {
                    const now = Date.now();
                    const alertKey = `${setting.guildId}-${zone.name}`;
                    const lastTime = lastAlertTime[alertKey] || 0;

                    // 쿨다운 체크
                    if (now - lastTime > setting.cooldownTime) {
                        const matchPixels = totalPixels - numDiffPixels;
                        await sendAlert(zone, matchPercentage, currentFlagBuffer, setting.guildId, matchPixels, totalPixels, numDiffPixels, serverThreshold);
                        lastAlertTime[alertKey] = now;
                        console.log(`✅ [${zone.name}] 서버 ${setting.guildId}에 알림 전송 완료 (임계값: ${serverThreshold}%)`);
                    } else {
                        const remaining = Math.ceil((setting.cooldownTime - (now - lastTime)) / 1000 / 60);
                        console.log(`⏳ [${zone.name}] 서버 ${setting.guildId} 쿨다운 중 (${remaining}분 남음)`);
                    }
                }
            }

        } catch (error) {
            console.error(`❌ ${zone.name} 감시 오류:`, error.message);
        }
    }
}

// ========================================
// 9. 알림 전송 함수
// ========================================
async function sendAlert(zone, percentage, imageBuffer, guildId, matchPixels, totalPixels, diffPixels, serverThreshold) {
    try {
        const setting = await Setting.findOne({ guildId: guildId });
        if (!setting || !setting.channelId) return;

        const channel = await client.channels.fetch(setting.channelId);
        if (!channel) return;

        const attachment = new AttachmentBuilder(imageBuffer, { name: 'alert.png' });
        const embed = new EmbedBuilder()
            .setTitle(`🚨 태극기 훼손 감지: ${zone.name}`)
            .setURL(zone.wplaceUrl)
            .setDescription(
                `${setting.roleId ? `<@&${setting.roleId}>` : '@everyone'} 즉각 대응이 필요합니다!\n` +
                `현재 일치율: **${percentage.toFixed(2)}%** (기준: ${serverThreshold}%)`
            )
            .addFields(
        { name: '픽셀 정보', value: `일치: ${matchPixels.toLocaleString()}/${totalPixels.toLocaleString()}\n불일치: ${diffPixels.toLocaleString()}개`, inline: false }
            )
            .setColor(0xFF0000)
            .setImage('attachment://alert.png')
            .setTimestamp();

        const mentionContent = setting.roleId ? `<@&${setting.roleId}>` : '@everyone';
        await channel.send({ content: mentionContent, embeds: [embed], files: [attachment] });
    } catch (error) {
        console.error(`❌ 알림 전송 오류 (서버: ${guildId}):`, error.message);
    }
}

// ========================================
// 10. 이벤트 핸들러
// ========================================
client.on('messageCreate', async (message) => {
    if (!message.content.toLowerCase().startsWith('w!') || message.author.bot) return;

    const args = message.content.slice(2).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();

    if (commands[commandName]) {
        try {
            await commands[commandName](message, args);
        } catch (error) {
            console.error('명령어 실행 오류:', error);
            message.reply('❌ 명령어 실행 중 오류가 발생했습니다.');
        }
    }
});

client.once('clientReady', () => {
    console.log(`✅ ${client.user.tag} 온라인! 감시 시스템 가동 중...`);
    console.log(`📡 ${client.guilds.cache.size}개 서버에서 활동 중`);

    // Rich Presence 설정
    let statusIndex = 0;
    const statuses = [
        { name: '태극기 감시하는 중', type: 0 },
        { name: 'w!help로 도움말 열기', type: 0 }
    ];
    
    // 초기 상태 설정
    client.user.setPresence({
        activities: [statuses[0]],
        status: 'online'
    });
    
    // 30초마다 상태 교체
    setInterval(() => {
        statusIndex = (statusIndex + 1) % statuses.length;
        client.user.setPresence({
            activities: [statuses[statusIndex]],
            status: 'online'
        });
    }, 30000);  // 30초 = 30000ms
    
    // 1분마다 감시 수행
    setInterval(checkZones, 1000 * 60 * 1);
});

// 봇이 새 서버에 추가되었을 때
client.on('guildCreate', async (guild) => {
    console.log(`✅ 새 서버 추가됨: ${guild.name} (ID: ${guild.id})`);
});

// ========================================
// 11. 봇 로그인
// ========================================
client.login(BOT_TOKEN);