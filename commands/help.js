// commands/help.js
// 도움말 명령어 (w!help) - Discord Components V2 버전

const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    MessageFlags
} = require('discord.js');
const { SUPPORT_SERVER_URL, DASHBOARD_URL } = require('../config/env');

// 카테고리별 명령어 정의
const CATEGORIES = [
    {
        id: 'basic',
        emoji: '📘',
        label: '기본 명령어',
        description: '누구나 사용 가능한 기본 명령어',
        color: 0x0099FF,
        heading: '📘 기본 명령어',
        commands: [
            { name: 'w!ping', desc: '봇의 응답 속도를 확인합니다.' },
            { name: 'w!status', desc: '현재 봇의 상태와 설정을 확인합니다.' },
            { name: 'w!flag [지역]', desc: '특정 지역의 실시간 상태를 확인합니다.\n예: `w!flag 독도`' },
            { name: 'w!history [지역]', desc: '최근 30분간 해당 지점의 일치율 변화 그래프를 출력합니다.\n예: `w!history 독도`' },
            { name: 'w!record (지역) (시간)', desc: '특정 지역을 지정한 시간동안 녹화합니다. (최대 24시간)\n예: `w!record 독도 1h`' },
            { name: 'w!record (타일X) (타일Y) (로컬X) (로컬Y)', desc: '원하는 영역의 작품 타임랩스를 녹화합니다. **(반드시 도안 이미지 첨부 필요)**\n예: `w!record 100 200 500 300`\n※ 30초마다 변화를 감지해 자동 저장합니다.' },
            { name: 'w!record stop', desc: '진행 중인 녹화를 중지하고 녹화된 프레임 수를 확인, 타임랩스 영상을 생성합니다.' },
            { name: 'w!record recover (ID)', desc: '영상 생성/전송 중 오류로 중단된 녹화를 복구합니다. (오류 발생 시 DM으로 안내되는 ID 사용)' },
            { name: 'w!help', desc: '이 도움말을 표시합니다.' }
        ],
        footer: '💡 위 메뉴에서 다른 카테고리를 선택할 수 있습니다'
    },
    {
        id: 'global',
        emoji: '🔧',
        label: '전역 설정',
        description: '[관리자 전용] 채널·역할·임계값 설정',
        color: 0xFFA500,
        heading: '🔧 관리자 전용 · 전역 설정',
        commands: [
            { name: 'w!setchannel [지역] #채널', desc: '알림을 받을 채널을 설정합니다.\n• `w!setchannel #알림` - 모든 지역 기본값\n• `w!setchannel 독도 #독도알림` - 특정 지역만' },
            { name: 'w!setrole [지역] @역할', desc: '알림 시 멘션할 역할을 설정합니다.\n• `w!setrole @경보` - 모든 지역 기본값\n• `w!setrole 서울 @서울팀` - 특정 지역만' },
            { name: 'w!setthreshold [지역] 값', desc: '태극기 훼손 감지 임계값을 설정합니다.\n• `w!setthreshold 85` - 모든 지역 기본값\n• `w!setthreshold 독도 88` - 특정 지역만\n※ 83% 이하는 권장하지 않습니다.' },
            { name: 'w!setcooldown [시간]', desc: '알림 쿨다운 시간을 설정합니다.\n예: `w!setcooldown 10m`, `w!setcooldown 1h`' }
        ],
        footer: '💡 [지역] 생략 시 전체 적용, 명시 시 해당 지역만 적용'
    },
    {
        id: 'zone',
        emoji: '🎯',
        label: '구역 관리',
        description: '[관리자 전용] 감시 활성화·정지',
        color: 0x2ECC71,
        heading: '🎯 관리자 전용 · 구역 관리',
        commands: [
            { name: 'w!disablezone [지역]', desc: '특정 지역의 감시를 비활성화합니다.\n예: `w!disablezone 서울`' },
            { name: 'w!enablezone [지역]', desc: '특정 지역의 감시를 재활성화합니다.\n예: `w!enablezone 서울`' },
            { name: 'w!pause [시간]', desc: '전체 감시를 일시 정지합니다.\n예: `w!pause 30m`, `w!pause` (무기한)' },
            { name: 'w!resume', desc: '일시 정지된 감시를 재개합니다.' }
        ],
        footer: '💡 구역별 세밀한 제어가 가능합니다'
    },
    {
        id: 'monitor',
        emoji: '🔍',
        label: '모니터링 & 기타',
        description: '[관리자 전용] 테스트 알림·쿨다운 초기화',
        color: 0x9B59B6,
        heading: '🔍 관리자 전용 · 모니터링',
        commands: [
            { name: 'w!testalert [지역] [silent]', desc: '테스트 알림을 전송합니다.\n• `w!testalert 독도` - 역할 멘션 포함\n• `w!testalert 독도 silent` - 역할 멘션 없이' },
            { name: 'w!resetcooldown [지역]', desc: '해당 지역 또는 전체 알림 쿨다운을 초기화합니다.\n예: `w!resetcooldown`, `w!resetcooldown 독도`' }
        ],
        extraHeading: '🎉 기타',
        extraCommands: [
            { name: 'w!mambo', desc: '???' }
        ],
        footer: '💡 문의 사항은 위 버튼의 지원 서버를 이용해 주세요'
    }
];

module.exports = (deps) => async (message) => {
    let currentIndex = 0;

    // 카테고리 선택 메뉴
    const buildSelectRow = (selectedIndex, disabled = false) => {
        const select = new StringSelectMenuBuilder()
            .setCustomId('help_category')
            .setPlaceholder('📂 카테고리를 선택하세요')
            .setDisabled(disabled)
            .addOptions(
                CATEGORIES.map((cat, idx) =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel(cat.label)
                        .setDescription(cat.description)
                        .setEmoji(cat.emoji)
                        .setValue(String(idx))
                        .setDefault(idx === selectedIndex)
                )
            );
        return new ActionRowBuilder().addComponents(select);
    };

    // 서포트 서버 / 대시보드 링크 버튼
    const buildLinkRow = () => {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('🎫 서포트 서버')
                .setStyle(ButtonStyle.Link)
                .setURL(SUPPORT_SERVER_URL),
            new ButtonBuilder()
                .setLabel('📊 실시간 대시보드')
                .setStyle(ButtonStyle.Link)
                .setURL(DASHBOARD_URL)
        );
    };

    // 카테고리 컨테이너 생성 (Components V2)
    const buildContainer = (index, selectDisabled = false) => {
        const cat = CATEGORIES[index];
        const container = new ContainerBuilder()
            .setAccentColor(cat.color)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `## 📋 Wcam 명령어 목록\n### ${cat.heading} (${index + 1}/${CATEGORIES.length})`
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
            );

        cat.commands.forEach((cmd, i) => {
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`**\`${cmd.name}\`**\n${cmd.desc}`)
            );
            const isLast = i === cat.commands.length - 1 && !cat.extraCommands;
            if (!isLast) {
                container.addSeparatorComponents(
                    new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small)
                );
            }
        });

        if (cat.extraCommands) {
            container.addSeparatorComponents(
                new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
            );
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`### ${cat.extraHeading}`)
            );
            cat.extraCommands.forEach((cmd) => {
                container.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`**\`${cmd.name}\`**\n${cmd.desc}`)
                );
            });
        }

        container
            .addSeparatorComponents(
                new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
            )
            .addActionRowComponents(buildSelectRow(index, selectDisabled))
            .addActionRowComponents(buildLinkRow())
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`-# ${cat.footer}`)
            );

        return container;
    };

    // 초기 메시지 전송
    const helpMessage = await message.reply({
        flags: MessageFlags.IsComponentsV2,
        components: [buildContainer(currentIndex)]
    });

    // 셀렉트 메뉴 이벤트 리스너
    const collector = helpMessage.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: (i) => i.user.id === message.author.id,
        time: 600000 // 10분간 활성화
    });

    collector.on('collect', async (interaction) => {
        if (interaction.customId === 'help_category') {
            currentIndex = Number(interaction.values[0]);
        }

        await interaction.update({
            flags: MessageFlags.IsComponentsV2,
            components: [buildContainer(currentIndex)]
        });
    });

    collector.on('end', () => {
        // 시간 만료 후 선택 메뉴 비활성화 (링크 버튼은 유지)
        helpMessage.edit({
            flags: MessageFlags.IsComponentsV2,
            components: [buildContainer(currentIndex, true)]
        }).catch(() => {}); // 메시지가 삭제된 경우 무시
    });
};