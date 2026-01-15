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
const DEVELOPER_ID = process.env.DEVELOPER_ID || '' ;

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
    cooldownTime: { type: Number, default: 600000 }, // 전역 쿨다운
    enabled: { type: Boolean, default: true }, // 전역 활성화 상태
    
    // 전역 기본 설정 (구역별 설정이 없을 때 사용)
    defaultChannelId: String,
    defaultRoleId: String,
    defaultThreshold: { type: Number, default: 90 },
    
    // 구역별 개별 설정
    zones: {
        type: Map,
        of: new mongoose.Schema({
            channelId: String,
            roleId: String,
            threshold: Number,
            enabled: { type: Boolean, default: true } // 구역별 활성화 상태
        }, { _id: false }),
        default: {}
    }
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
    },
    {
        name: "백두산 태극기",
        tileUrl: "https://backend.wplace.live/files/s0/tiles/1752/760.png",
        originalPath: "./assets/ref_baekdu.png",
        x: 374, y: 111, width: 204, height: 159,
        wplaceUrl: "https://wplace.live/?lat=42.00718311351218&lng=128.05373990302732&zoom=13.726827756600123"
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

// 구역 이름으로 구역 객체 찾기
function findZone(zoneName) {
    if (!zoneName) return null;
    const normalized = zoneName.toLowerCase().trim();
    return monitorZones.find(z => 
        z.name.toLowerCase().includes(normalized) ||
        normalized.includes(z.name.toLowerCase())
    );
}

// 설정에서 구역별 값 가져오기 (구역 설정 > 전역 기본값 우선순위)
function getZoneSetting(setting, zoneName, key) {
    if (!setting) return null;
    
    // 구역별 설정이 있으면 우선 사용
    if (setting.zones && setting.zones.has(zoneName)) {
        const zoneConfig = setting.zones.get(zoneName);
        if (zoneConfig[key] !== undefined && zoneConfig[key] !== null) {
            return zoneConfig[key];
        }
    }
    
    // 구역별 설정이 없으면 전역 기본값 사용
    const defaultKey = `default${key.charAt(0).toUpperCase() + key.slice(1)}`;
    return setting[defaultKey];
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
        // 인자가 없는 경우
    if (args.length === 0) {
        return message.reply('❌ 사용법: `w!setchannel [구역] #채널` 또는 `w!setchannel #채널` (전체 적용)');
    }
    
    let zoneName = null;
    let channelId = null;
    
    // 경우 1: w!setchannel #채널 (전체 적용)
    if (args.length === 1) {
        channelId = args[0].replace(/[<#>]/g, '');
    }
    // 경우 2: w!setchannel 독도 #채널 (특정 구역)
    else if (args.length >= 2) {
        // 마지막 인자가 채널
        channelId = args[args.length - 1].replace(/[<#>]/g, '');
        // 나머지가 구역 이름
        zoneName = args.slice(0, -1).join(' ');
        
        // 구역 유효성 검사
        const zone = findZone(zoneName);
        if (!zone) {
            return message.reply(`❌ '${zoneName}' 구역을 찾을 수 없습니다. 사용 가능한 구역: ${monitorZones.map(z => z.name).join(', ')}`);
        }
        zoneName = zone.name; // 정확한 이름으로 통일
    }
    
    // 채널 유효성 검사
    const channel = message.guild.channels.cache.get(channelId);
    if (!channel) {
        return message.reply('❌ 해당 채널을 찾을 수 없습니다. 올바른 채널을 입력해주세요.');
    }
    if (!channel.isTextBased()) {
        return message.reply('❌ 텍스트 채널만 설정할 수 있습니다.');
    }
    
    // DB 업데이트
    if (zoneName) {
        // 특정 구역에만 적용
        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { $set: { [`zones.${zoneName}.channelId`]: channelId } },
            { upsert: true }
        );
        message.reply(`✅ **${zoneName}** 구역의 알림 채널이 <#${channelId}>(으)로 설정되었습니다.`);
    } else {
        // 전체 기본값으로 적용
        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { defaultChannelId: channelId },
            { upsert: true }
        );
        message.reply(`✅ 모든 구역의 기본 알림 채널이 <#${channelId}>(으)로 설정되었습니다.\n(개별 구역 설정이 없는 경우 이 채널이 사용됩니다)`);
    }
},

    'setrole': async (message, args) => {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('❌ 관리자 권한이 필요합니다.');
        }
        if (args.length === 0) {
        return message.reply('❌ 사용법: `w!setrole [구역] @역할` 또는 `w!setrole @역할` (전체 적용)');
    }
    
    let zoneName = null;
    let roleId = null;
    
    // 경우 1: w!setrole @역할 (전체 적용)
    if (args.length === 1) {
        roleId = args[0].replace(/[<@&>]/g, '');
    }
    // 경우 2: w!setrole 독도 @역할 (특정 구역)
    else if (args.length >= 2) {
        roleId = args[args.length - 1].replace(/[<@&>]/g, '');
        zoneName = args.slice(0, -1).join(' ');
        
        const zone = findZone(zoneName);
        if (!zone) {
            return message.reply(`❌ '${zoneName}' 구역을 찾을 수 없습니다.`);
        }
        zoneName = zone.name;
    }
    
    // 역할 유효성 검사
    const role = message.guild.roles.cache.get(roleId);
    if (!role) {
        return message.reply('❌ 해당 역할을 찾을 수 없습니다.');
    }
    
    // DB 업데이트
    if (zoneName) {
        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { $set: { [`zones.${zoneName}.roleId`]: roleId } },
            { upsert: true }
        );
        message.reply(`✅ **${zoneName}** 구역의 알림 역할이 ${role.name}(으)로 설정되었습니다.`);
    } else {
        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { defaultRoleId: roleId },
            { upsert: true }
        );
        message.reply(`✅ 모든 구역의 기본 알림 역할이 ${role.name}(으)로 설정되었습니다.`);
    }
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

    if (args.length === 0) {
        return message.reply('❌ 사용법: `w!setthreshold [구역] 값` 또는 `w!setthreshold 값` (전체 적용)\n예: `w!setthreshold 85` 또는 `w!setthreshold 독도 88`');
    }
    
    let zoneName = null;
    let thresholdValue = null;
    
    // 경우 1: w!setthreshold 85 (전체 적용)
    if (args.length === 1) {
        thresholdValue = parseFloat(args[0]);
    }
    // 경우 2: w!setthreshold 독도 88 (특정 구역)
    else if (args.length >= 2) {
        thresholdValue = parseFloat(args[args.length - 1]);
        zoneName = args.slice(0, -1).join(' ');
        
        const zone = findZone(zoneName);
        if (!zone) {
            return message.reply(`❌ '${zoneName}' 구역을 찾을 수 없습니다.`);
        }
        zoneName = zone.name;
    }
    
    // 숫자 유효성 검사
    if (isNaN(thresholdValue)) {
        return message.reply('❌ 올바른 숫자를 입력해주세요. (예: w!setthreshold 85)');
    }
    
    // 범위 검사 (0~100)
    if (thresholdValue < 0 || thresholdValue > 100) {
        return message.reply('❌ 임계값은 0에서 100 사이의 값이어야 합니다.');
    }
    
    // DB 업데이트
    if (zoneName) {
        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { $set: { [`zones.${zoneName}.threshold`]: thresholdValue } },
            { upsert: true }
        );
        message.reply(`✅ **${zoneName}**의 훼손 감지 임계값이 **${thresholdValue}%**로 설정되었습니다.`);
    } else {
        await Setting.findOneAndUpdate(
            { guildId: message.guild.id },
            { defaultThreshold: thresholdValue },
            { upsert: true }
        );
        message.reply(`✅ 모든 구역의 기본 임계값이 **${thresholdValue}%**로 설정되었습니다.\n(개별 구역 설정이 없는 경우 이 값이 사용됩니다)`);
    }
},

    'status': async (message) => {
        const setting = await Setting.findOne({ guildId: message.guild.id });
    
    const embed = new EmbedBuilder()
        .setTitle('📊 Wcam 봇 상태')
        .setColor(0x0099FF)
        .setTimestamp();
    
    // 감시 중인 구역
    const zoneList = monitorZones.map(z => z.name).join('\n');
    embed.addFields({ name: '🔍 감시 중인 구역', value: zoneList, inline: false });
    
    if (setting) {
        // 전역 설정
        const globalSettings = 
            `**상태:** ${setting.enabled ? '✅ 활성화' : '⏸️ 일시 정지'}\n` +
            `**쿨다운:** ${setting.cooldownTime / 60000}분`;
        embed.addFields({ name: '⚙️ 전역 설정', value: globalSettings, inline: false });
        
        // 기본 설정
        const defaultChannel = setting.defaultChannelId ? `<#${setting.defaultChannelId}>` : '미설정';
        const defaultRole = setting.defaultRoleId 
            ? (message.guild.roles.cache.get(setting.defaultRoleId)?.name || setting.defaultRoleId)
            : '미설정';
        const defaultThreshold = setting.defaultThreshold || 90;
        
        const defaultSettings = 
            `**채널:** ${defaultChannel}\n` +
            `**역할:** ${defaultRole}\n` +
            `**임계값:** ${defaultThreshold}%`;
        embed.addFields({ name: '📌 기본 설정', value: defaultSettings, inline: false });
        
        // 구역별 개별 설정
        if (setting.zones && setting.zones.size > 0) {
            let zoneSettings = '';
            for (const [zoneName, zoneConfig] of setting.zones) {
                const parts = [];
                if (zoneConfig.channelId) {
                    parts.push(`채널: <#${zoneConfig.channelId}>`);
                }
                if (zoneConfig.roleId) {
                    const role = message.guild.roles.cache.get(zoneConfig.roleId);
                    parts.push(`역할: ${role ? role.name : zoneConfig.roleId}`);
                }
                if (zoneConfig.threshold !== undefined) {
                    parts.push(`임계값: ${zoneConfig.threshold}%`);
                }
                if (zoneConfig.enabled === false) {
                    parts.push(`⏸️ 비활성화`);
                }
                
                if (parts.length > 0) {
                    zoneSettings += `**${zoneName}**\n${parts.join(' | ')}\n\n`;
                }
            }
            
            if (zoneSettings) {
                embed.addFields({ name: '🎯 구역별 개별 설정', value: zoneSettings.trim(), inline: false });
            }
        }
    } else {
        embed.setDescription('아직 설정되지 않았습니다.\n`w!setchannel`과 `w!setrole`로 설정해주세요.');
    }
    
    message.reply({ embeds: [embed] });
},

    'flag': async (message, args) => {
        const zoneName = args.join(' ');
        if (!zoneName) return message.reply('❌ 확인할 구역 이름을 입력해주세요. (예: w!flag 독도)');

        const zone = findZone(zoneName);
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
            const serverThreshold = getZoneSetting(setting, zone.name, 'threshold') || 90;

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

        // silent 옵션 확인
        const isSilent = args.includes('silent');

        // silent 제거 후 구역 이름 추출
        const zoneNameArgs = args.filter(arg => arg.toLowerCase() !== 'silent');
        const zoneName = zoneNameArgs.join(' ') || "독도 태극기";
    
        const zone = findZone(zoneName);
        if (!zone) return message.reply('❌ 테스트할 구역을 찾을 수 없습니다.');

        const silentText = isSilent ? ' (조용한 모드)' : '';
        message.reply(`🔔 [테스트] ${zone.name} 구역의 강제 알림 테스트를 시작합니다...${silentText}`);

        try {
            const response = await axios.get(zone.tileUrl, { responseType: 'arraybuffer' });
            const currentFlagBuffer = await sharp(Buffer.from(response.data))
                .extract({ left: zone.x, top: zone.y, width: zone.width, height: zone.height })
                .toBuffer();

            const testTotalPixels = zone.width * zone.height;
            const setting = await Setting.findOne({ guildId: message.guild.id });

            const channelId = getZoneSetting(setting, zone.name, 'channelId');
            const roleId = getZoneSetting(setting, zone.name, 'roleId');
            const serverThreshold = getZoneSetting(setting, zone.name, 'threshold') || 90;
        
          await sendAlert(
            zone, 
            0.00, 
            currentFlagBuffer, 
            message.guild.id, 
            0, 
            testTotalPixels, 
            testTotalPixels, 
            serverThreshold,
            channelId,
            roleId,
            isSilent
        );
        const resultText = isSilent 
            ? '✅ 테스트 알림이 전송되었습니다. (역할 멘션 없음)'
            : '✅ 테스트 알림이 전송되었습니다. (역할 멘션 포함)';
        message.channel.send(resultText);
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

        const zone = findZone(zoneName);
        if (!zone) return message.reply(`❌ '${zoneName}' 구역을 찾을 수 없습니다.`);

        delete lastAlertTime[`${message.guild.id}-${zone.name}`];
        message.reply(`✅ ${zone.name}의 알림 쿨다운이 초기화되었습니다.`);
    },

    'disablezone': async (message, args) => {
    if (!message.member.permissions.has('Administrator')) {
        return message.reply('❌ 관리자 권한이 필요합니다.');
    }
    
    const zoneName = args.join(' ');
    if (!zoneName) {
        return message.reply('❌ 비활성화할 구역을 입력해주세요.\n예: `w!disablezone 독도`');
    }
    
    const zone = findZone(zoneName);
    if (!zone) {
        return message.reply(`❌ '${zoneName}' 구역을 찾을 수 없습니다.\n사용 가능한 구역: ${monitorZones.map(z => z.name).join(', ')}`);
    }
    
    await Setting.findOneAndUpdate(
        { guildId: message.guild.id },
        { $set: { [`zones.${zone.name}.enabled`]: false } },
        { upsert: true }
    );
    
    message.reply(`⏸️ **${zone.name}** 구역의 감시가 비활성화되었습니다.\n재활성화하려면 \`w!enablezone ${zone.name}\`을 입력하세요.`);
},

'enablezone': async (message, args) => {
    if (!message.member.permissions.has('Administrator')) {
        return message.reply('❌ 관리자 권한이 필요합니다.');
    }
    
    const zoneName = args.join(' ');
    if (!zoneName) {
        return message.reply('❌ 활성화할 구역을 입력해주세요.\n예: `w!enablezone 독도`');
    }
    
    const zone = findZone(zoneName);
    if (!zone) {
        return message.reply(`❌ '${zoneName}' 구역을 찾을 수 없습니다.\n사용 가능한 구역: ${monitorZones.map(z => z.name).join(', ')}`);
    }
    
    await Setting.findOneAndUpdate(
        { guildId: message.guild.id },
        { $set: { [`zones.${zone.name}.enabled`]: true } },
        { upsert: true }
    );
    
    message.reply(`✅ **${zone.name}** 구역의 감시가 활성화되었습니다.`);
},

    'help': async (message) => {
    // 페이지별 컨텐츠 정의
    const pages = [
        // 페이지 1: 기본 명령어
        new EmbedBuilder()
            .setTitle('📋 Wcam 명령어 목록 (1/4)')
            .setColor(0x0099FF)
            .setDescription('**기본 명령어**')
            .addFields(
                { name: 'w!ping', value: '봇의 응답 속도를 확인합니다.', inline: false },
                { name: 'w!status', value: '현재 봇의 상태와 설정을 확인합니다.', inline: false },
                { name: 'w!flag [지역]', value: '특정 구역의 실시간 상태를 확인합니다.\n예: `w!flag 독도`', inline: false },
                { name: 'w!help', value: '이 도움말을 표시합니다.', inline: false }
            )
            .setFooter({ text: '💡 화살표 버튼으로 페이지 이동' })
            .setTimestamp(),

        // 페이지 2: 전역 설정
        new EmbedBuilder()
            .setTitle('📋 Wcam 명령어 목록 (2/4)')
            .setColor(0x0099FF)
            .setDescription('**🔧 관리자 전용 - 전역 설정**')
            .addFields(
                { name: 'w!setchannel [구역] #채널', value: '알림을 받을 채널을 설정합니다.\n• `w!setchannel #알림` - 모든 구역 기본값\n• `w!setchannel 독도 #독도알림` - 특정 구역만', inline: false },
                { name: 'w!setrole [구역] @역할', value: '알림 시 멘션할 역할을 설정합니다.\n• `w!setrole @경보` - 모든 구역 기본값\n• `w!setrole 서울 @서울팀` - 특정 구역만', inline: false },
                { name: 'w!setthreshold [구역] 값', value: '태극기 훼손 감지 임계값을 설정합니다.\n• `w!setthreshold 85` - 모든 구역 기본값\n• `w!setthreshold 독도 88` - 특정 구역만\n※ 83% 이하는 권장하지 않습니다.', inline: false },
                { name: 'w!setcooldown [시간]', value: '알림 쿨다운 시간을 설정합니다.\n예: `w!setcooldown 10m`, `w!setcooldown 1h`', inline: false }
            )
            .setFooter({ text: '💡 [구역] 생략 시 전체 적용, 명시 시 해당 구역만 적용' })
            .setTimestamp(),

        // 페이지 3: 구역 관리
        new EmbedBuilder()
            .setTitle('📋 Wcam 명령어 목록 (3/4)')
            .setColor(0x0099FF)
            .setDescription('**🎯 관리자 전용 - 구역 관리**')
            .addFields(
                { name: 'w!disablezone [구역]', value: '특정 구역의 감시를 비활성화합니다.\n예: `w!disablezone 서울`', inline: false },
                { name: 'w!enablezone [구역]', value: '특정 구역의 감시를 재활성화합니다.\n예: `w!enablezone 서울`', inline: false },
                { name: 'w!pause [시간]', value: '전체 감시를 일시 정지합니다.\n예: `w!pause 30m`, `w!pause` (무기한)', inline: false },
                { name: 'w!resume', value: '일시 정지된 감시를 재개합니다.', inline: false }
            )
            .setFooter({ text: '💡 구역별 세밀한 제어가 가능합니다' })
            .setTimestamp(),

        // 페이지 4: 모니터링 & 기타
        new EmbedBuilder()
            .setTitle('📋 Wcam 명령어 목록 (4/4)')
            .setColor(0x0099FF)
            .setDescription('**🔍 관리자 전용 - 모니터링**')
            .addFields(
                { name: 'w!testalert [지역] [silent]', value: '테스트 알림을 전송합니다.\n• `w!testalert 독도` - 역할 멘션 포함\n• `w!testalert 독도 silent` - 역할 멘션 없이', inline: false },
                { name: 'w!resetcooldown [지역]', value: '해당 지역 또는 전체 알림 쿨다운을 초기화합니다.\n예: `w!resetcooldown`, `w!resetcooldown 독도`', inline: false }
            )
            .addFields({ name: '\u200B', value: '**🎉 기타**', inline: false })
            .addFields(
                { name: 'w!mambo', value: '???', inline: false }
            )
            .setFooter({ text: '💡 문의 사항은 봇 프로필의 지원 서버로.' })
            .setTimestamp()
    ];

    let currentPage = 0;

    // 버튼 생성 (discord.js v14 방식)
    const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
    
    const getButtons = (page) => {
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('prev')
                    .setLabel('◀ 이전')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('page')
                    .setLabel(`${page + 1} / ${pages.length}`)
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId('next')
                    .setLabel('다음 ▶')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === pages.length - 1)
            );
        return row;
    };

    // 초기 메시지 전송
    const helpMessage = await message.reply({
        embeds: [pages[currentPage]],
        components: [getButtons(currentPage)]
    });

    // 버튼 클릭 이벤트 리스너
    const collector = helpMessage.createMessageComponentCollector({
        filter: (i) => i.user.id === message.author.id,
        time: 600000 // 10분간 버튼 활성화
    });

    collector.on('collect', async (interaction) => {
        if (interaction.customId === 'prev') {
            currentPage = Math.max(0, currentPage - 1);
        } else if (interaction.customId === 'next') {
            currentPage = Math.min(pages.length - 1, currentPage + 1);
        }

        await interaction.update({
            embeds: [pages[currentPage]],
            components: [getButtons(currentPage)]
        });
    });

    collector.on('end', () => {
        // 5분 후 버튼 비활성화
        helpMessage.edit({
            embeds: [pages[currentPage]],
            components: []
        }).catch(() => {}); // 메시지가 삭제된 경우 무시
    });
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
                if (setting.defaultChannelId) {
                    try {
                        const channel = await client.channels.fetch(setting.defaultChannelId);
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

    'getinvite': async (message, args) => {
        // 1. 개발자 본인 확인
        if (message.author.id !== DEVELOPER_ID) {
            return message.reply('❌ 이 명령어는 개발자만 사용할 수 있습니다.');
        }

        // 2. 서버 ID 인자 확인
        const targetGuildId = args[0];
        if (!targetGuildId) {
            return message.reply('❌ 서버 ID를 입력해주세요. 사용법: `w!getinvite (서버 ID)`');
        }

        try {
            // 3. 봇이 해당 서버에 있는지 확인
            const guild = client.guilds.cache.get(targetGuildId);
            if (!guild) {
                return message.reply('❌ 봇이 해당 서버에 참여하고 있지 않거나, 잘못된 서버 ID입니다.');
            }

            // 4. 초대장을 생성할 수 있는 채널 찾기 (첫 번째 텍스트 채널)
            const channel = guild.channels.cache.find(ch => 
                ch.isTextBased() && 
                ch.permissionsFor(guild.members.me).has('CreateInstantInvite')
            );

            if (!channel) {
                return message.reply('❌ 해당 서버에서 초대장을 생성할 권한이 없거나 적절한 채널을 찾을 수 없습니다.');
            }

            // 5. 초대장 생성
            const invite = await channel.createInvite({
                maxAge: 0,
                maxUses: 0,
                unique: true,
            });

            // 6. 개발자에게 DM으로 전송 시도
            try {
                await message.author.send(`✅ **${guild.name}** 서버의 초대장이 생성되었습니다:\n${invite.url}`);
                message.reply('📬 초대장을 DM으로 전송했습니다.');
            } catch (dmError) {
                // DM이 차단되어 있을 경우 채널에 직접 전송 (보안상 주의)
                message.reply(`⚠️ DM 전송에 실패했습니다. 초대장: ${invite.url}`);
            }

        } catch (error) {
            console.error('초대장 생성 오류:', error);
            message.reply('❌ 초대장을 생성하는 중 오류가 발생했습니다.');
        }
    },

    'updatenotif': async (message) => {
    // 1. 개발자 본인 확인
    if (message.author.id !== DEVELOPER_ID) {
        return message.reply('❌ 이 명령어는 개발자만 사용할 수 있습니다.');
    }

    const statusMsg = await message.reply('📢 업데이트 알림을 전송하는 중...');
    
    let successCount = 0;
    let failCount = 0;
    const failedServers = [];

    // 2. 모든 서버 순회
    for (const [guildId, guild] of client.guilds.cache) {
        try {
            // 메시지 전송 권한이 있는 첫 번째 텍스트 채널 찾기
            const channel = guild.channels.cache.find(ch => 
                ch.isTextBased() && 
                ch.permissionsFor(guild.members.me).has('SendMessages') &&
                ch.permissionsFor(guild.members.me).has('EmbedLinks')
            );
            
            if (!channel) {
                failCount++;
                failedServers.push(`${guild.name} (전송 가능한 채널 없음)`);
                continue;
            }

            // 임베드 메시지 생성
            const embed = new EmbedBuilder()
                .setTitle('🔔 봇 업데이트 알림')
                .setDescription('봇이 업데이트 되었습니다.\n`w!status` 명령어를 사용하여 서버 설정을 다시 한번 확인해주세요.')
                .setColor(0x0099FF)
                .setTimestamp();

            // 메시지 전송 (멘션 없음)
            await channel.send({ embeds: [embed] });
            successCount++;
            
        } catch (error) {
            console.error(`알림 전송 실패 (${guild.name}):`, error.message);
            failCount++;
            failedServers.push(`${guild.name} (오류: ${error.message})`);
        }
    }

    // 3. 결과 보고
    const resultEmbed = new EmbedBuilder()
        .setTitle('📊 업데이트 알림 전송 완료')
        .setColor(failCount > 0 ? 0xFFA500 : 0x00FF00)
        .addFields(
            { name: '✅ 성공', value: `${successCount}개 서버`, inline: true },
            { name: '❌ 실패', value: `${failCount}개 서버`, inline: true },
            { name: '📈 전체', value: `${client.guilds.cache.size}개 서버`, inline: true }
        )
        .setTimestamp();

    if (failedServers.length > 0) {
        const failedList = failedServers.slice(0, 10).join('\n');
        const moreText = failedServers.length > 10 ? `\n... 외 ${failedServers.length - 10}개` : '';
        resultEmbed.addFields({ 
            name: '⚠️ 실패한 서버 목록', 
            value: failedList + moreText, 
            inline: false 
        });
    }

    await statusMsg.edit({ content: null, embeds: [resultEmbed] });
},

'servers': async (message) => {
    // 1. 개발자 본인 확인
    if (message.author.id !== DEVELOPER_ID) {
        return message.reply('❌ 이 명령어는 개발자만 사용할 수 있습니다.');
    }

    const statusMsg = await message.reply('📊 서버 목록을 불러오는 중...');
    
    // 2. 서버 정보 수집
    const guilds = Array.from(client.guilds.cache.values());
    
    // 총 통계
    const totalMembers = guilds.reduce((sum, g) => sum + g.memberCount, 0);
    const totalChannels = guilds.reduce((sum, g) => sum + g.channels.cache.size, 0);
    
    // 3. 서버 목록을 여러 페이지로 나누기 (한 페이지당 10개)
    const PAGE_SIZE = 10;
    const totalPages = Math.ceil(guilds.length / PAGE_SIZE);
    
    const createEmbed = async (pageIndex) => {
        const start = pageIndex * PAGE_SIZE;
        const end = Math.min(start + PAGE_SIZE, guilds.length);
        const pageGuilds = guilds.slice(start, end);
        
        const embed = new EmbedBuilder()
            .setTitle(`🌐 봇 서버 목록 (${pageIndex + 1}/${totalPages})`)
            .setColor(0x0099FF)
            .setDescription(
                `**전체 통계**\n` +
                `📊 총 서버: ${guilds.length}개\n` +
                `👥 총 멤버: ${totalMembers.toLocaleString()}명\n` +
                `📺 총 채널: ${totalChannels.toLocaleString()}개\n\n` +
                `**서버 목록 (${start + 1}-${end}/${guilds.length})**`
            )
            .setTimestamp();
        
        // 각 서버 정보 추가
        for (const guild of pageGuilds) {
            const owner = await client.users.fetch(guild.ownerId).catch(() => null);
            const ownerTag = owner ? `${owner.tag}` : '알 수 없음';
            
            // 서버 설정 정보 가져오기
            const setting = await Setting.findOne({ guildId: guild.id });
            const hasSetup = setting && setting.defaultChannelId ? '✅' : '⚠️';
            
            const info = 
                `**ID:** \`${guild.id}\`\n` +
                `👥 멤버: ${guild.memberCount.toLocaleString()}명\n` +
                `📺 채널: ${guild.channels.cache.size}개\n` +
                `👑 소유자: ${ownerTag}\n` +
                `${hasSetup} 설정 상태\n` +
                `📅 가입일: <t:${Math.floor(guild.joinedTimestamp / 1000)}:R>`;
            
            embed.addFields({
                name: `${guild.name}`,
                value: info,
                inline: false
            });
        }
        
        return embed;
    };
    
    // 4. 첫 페이지 전송
    let currentPage = 0;
    const firstEmbed = await createEmbed(0);
    
    // 페이지가 1개면 버튼 없이 전송
    if (totalPages === 1) {
        return await statusMsg.edit({ content: null, embeds: [firstEmbed] });
    }
    
    // 5. 페이지 네비게이션 버튼 생성
    const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
    
    const getButtons = (page) => {
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('first')
                    .setLabel('⏮️ 첫 페이지')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('prev')
                    .setLabel('◀ 이전')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('page')
                    .setLabel(`${page + 1} / ${totalPages}`)
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId('next')
                    .setLabel('다음 ▶')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === totalPages - 1),
                new ButtonBuilder()
                    .setCustomId('last')
                    .setLabel('마지막 페이지 ⏭️')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === totalPages - 1)
            );
        return row;
    };
    
    // 6. 초기 메시지 업데이트
    const serverListMsg = await statusMsg.edit({
        content: null,
        embeds: [firstEmbed],
        components: [getButtons(currentPage)]
    });
    
    // 7. 버튼 클릭 이벤트 리스너
    const collector = serverListMsg.createMessageComponentCollector({
        filter: (i) => i.user.id === message.author.id,
        time: 600000 // 10분간 버튼 활성화
    });
    
    collector.on('collect', async (interaction) => {
        if (interaction.customId === 'first') {
            currentPage = 0;
        } else if (interaction.customId === 'prev') {
            currentPage = Math.max(0, currentPage - 1);
        } else if (interaction.customId === 'next') {
            currentPage = Math.min(totalPages - 1, currentPage + 1);
        } else if (interaction.customId === 'last') {
            currentPage = totalPages - 1;
        }
        
        const newEmbed = await createEmbed(currentPage);
        await interaction.update({
            embeds: [newEmbed],
            components: [getButtons(currentPage)]
        });
    });
    
    collector.on('end', () => {
        // 10분 후 버튼 비활성화
        serverListMsg.edit({
            components: []
        }).catch(() => {}); // 메시지가 삭제된 경우 무시
    });
},

    'leaveserver': async (message, args) => {
        // 1. 개발자 본인 확인 (DEVELOPER_ID는 상단에 정의된 변수 사용)
        if (message.author.id !== DEVELOPER_ID) {
            return message.reply('❌ 이 명령어는 개발자만 사용할 수 있습니다.');
        }

        // 2. 서버 ID 인자 확인
        const targetGuildId = args[0];
        if (!targetGuildId) {
            return message.reply('❌ 퇴장할 서버 ID를 입력해주세요. 사용법: `w!leaveserver (서버 ID)`');
        }

        try {
            // 3. 봇이 해당 서버에 있는지 확인
            const guild = client.guilds.cache.get(targetGuildId);
            if (!guild) {
                return message.reply('❌ 봇이 해당 서버에 참여하고 있지 않거나, 잘못된 서버 ID입니다.');
            }

            const guildName = guild.name;

            // 4. 서버 퇴장 실행
            await guild.leave();

            // 5. 결과 보고 (콘솔 및 채팅)
            console.log(`🖕 개발자 지시로 ${guildName}에서 퇴장하였습니다.`);
            message.reply(`✅ 성공적으로 **${guildName}** 서버에서 퇴장하였습니다.`);

        } catch (error) {
            console.error('서버 퇴장 중 오류 발생:', error);
            message.reply('❌ 서버에서 퇴장하는 중 예외가 발생했습니다. 콘솔 로그를 확인해주세요.');
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
                // 구역별 설정 가져오기
                const channelId = getZoneSetting(setting, zone.name, 'channelId');
                const roleId = getZoneSetting(setting, zone.name, 'roleId');
                const threshold = getZoneSetting(setting, zone.name, 'threshold') || 90;
                
                // 채널이 설정되지 않은 경우 스킵
                if (!channelId) {
                    continue;
                }
                
                // 구역별 활성화 상태 확인
                const zoneEnabled = setting.zones?.has(zone.name) 
                    ? (setting.zones.get(zone.name).enabled !== false)
                    : true;
                
                if (!zoneEnabled) {
                    continue;
                }

                // 임계값 미만일 경우에만 알림
                if (matchPercentage < threshold) {
                    const now = Date.now();
                    const alertKey = `${setting.guildId}-${zone.name}`;
                    const lastTime = lastAlertTime[alertKey] || 0;

                    // 쿨다운 체크
                    if (now - lastTime > setting.cooldownTime) {
                        const matchPixels = totalPixels - numDiffPixels;
                        await sendAlert(
                            zone, 
                            matchPercentage, 
                            currentFlagBuffer, 
                            setting.guildId, 
                            matchPixels, 
                            totalPixels, 
                            numDiffPixels, 
                            threshold,
                            channelId,
                            roleId
                        );
                        lastAlertTime[alertKey] = now;
                        console.log(`✅ [${zone.name}] 서버 ${setting.guildId}에 알림 전송 완료 (임계값: ${threshold}%)`);
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
async function sendAlert(zone, percentage, imageBuffer, guildId, matchPixels, totalPixels, diffPixels, serverThreshold, channelId, roleId, suppressMention = false) {
    try {
        // channelId와 roleId를 인자로 받음 (구역별 설정 반영)
        if (!channelId) return;

        const channel = await client.channels.fetch(channelId);
        if (!channel) return;

        const attachment = new AttachmentBuilder(imageBuffer, { name: 'alert.png' });
        const embed = new EmbedBuilder()
            .setTitle(`🚨 태극기 훼손 감지: ${zone.name}`)
            .setURL(zone.wplaceUrl)
            .setDescription(
                `${roleId ? `<@&${roleId}>` : '@everyone'} 즉각 대응이 필요합니다!\n` +
                `현재 일치율: **${percentage.toFixed(2)}%** (기준: ${serverThreshold}%)`
            )
            .addFields(
                { name: '픽셀 정보', value: `일치: ${matchPixels.toLocaleString()}/${totalPixels.toLocaleString()}\n불일치: ${diffPixels.toLocaleString()}개`, inline: false }
            )
            .setColor(0xFF0000)
            .setImage('attachment://alert.png')
            .setTimestamp();

        // suppressMention이 true면 멘션 없이, false면 기존 로직 사용
       const mentionContent = suppressMention 
            ? null
            : (roleId ? `<@&${roleId}>` : '@everyone');

        // content가 null이면 전송하지 않음
        const messagePayload = {
            embeds: [embed],
            files: [attachment]
        };

        if (mentionContent) {
            messagePayload.content = mentionContent;
        }

        await channel.send(messagePayload);
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

// 봇이 서버에서 퇴장하거나 서버가 삭제되었을 때 실행
client.on('guildDelete', (guild) => {
    // 참고: guild 객체가 부분적(partial)일 수 있으므로 이름이 없을 경우를 대비합니다.
    const guildName = guild.name || '알 수 없는 서버';
    console.log(`📤 ${guildName}에서 퇴장함.`);
});

// ========================================
// 11. 봇 로그인
// ========================================
client.login(BOT_TOKEN);