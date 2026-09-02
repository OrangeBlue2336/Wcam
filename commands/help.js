// commands/help.js
// 도움말 명령어 (w!help)

const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { SUPPORT_SERVER_URL, DASHBOARD_URL } = require('../config/env');

module.exports = (deps) => async (message) => {
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
                { name: 'w!flag [지역]', value: '특정 지역의 실시간 상태를 확인합니다.\n예: `w!flag 독도`', inline: false },
                { name: 'w!history [지역]', value: '최근 30분간 해당 지점의 일치율 변화 그래프를 출력합니다.\n예: `w!history 독도`', inline: false },
                { name: 'w!record (지역) (시간)', value: '특정 지역을 지정한 시간동안 녹화합니다. (최대 24시간)\n예: `w!record 독도 1h`', inline: false },
                { name: 'w!record (타일X) (타일Y) (로컬X) (로컬Y)', value: '원하는 영역의 작품 타임랩스를 녹화합니다. **(반드시 도안 이미지 첨부 필요)**\n예: `w!record 100 200 500 300`\n※ 30초마다 변화를 감지해 자동 저장합니다.', inline: false },
                { name: 'w!record stop', value: '진행 중인 녹화를 중지하고 녹화된 프레임 수를 확인, 타임랩스 영상을 생성합니다.', inline: false },
                { name: 'w!record recover (ID)', value: '영상 생성/전송 중 오류로 중단된 녹화를 복구합니다. (오류 발생 시 DM으로 안내되는 ID 사용)', inline: false },
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
                { name: 'w!setchannel [지역] #채널', value: '알림을 받을 채널을 설정합니다.\n• `w!setchannel #알림` - 모든 지역 기본값\n• `w!setchannel 독도 #독도알림` - 특정 지역만', inline: false },
                { name: 'w!setrole [지역] @역할', value: '알림 시 멘션할 역할을 설정합니다.\n• `w!setrole @경보` - 모든 지역 기본값\n• `w!setrole 서울 @서울팀` - 특정 지역만', inline: false },
                { name: 'w!setthreshold [지역] 값', value: '태극기 훼손 감지 임계값을 설정합니다.\n• `w!setthreshold 85` - 모든 지역 기본값\n• `w!setthreshold 독도 88` - 특정 지역만\n※ 83% 이하는 권장하지 않습니다.', inline: false },
                { name: 'w!setcooldown [시간]', value: '알림 쿨다운 시간을 설정합니다.\n예: `w!setcooldown 10m`, `w!setcooldown 1h`', inline: false }
            )
            .setFooter({ text: '💡 [지역] 생략 시 전체 적용, 명시 시 해당 지역만 적용' })
            .setTimestamp(),

        // 페이지 3: 구역 관리
        new EmbedBuilder()
            .setTitle('📋 Wcam 명령어 목록 (3/4)')
            .setColor(0x0099FF)
            .setDescription('**🎯 관리자 전용 - 구역 관리**')
            .addFields(
                { name: 'w!disablezone [지역]', value: '특정 지역의 감시를 비활성화합니다.\n예: `w!disablezone 서울`', inline: false },
                { name: 'w!enablezone [지역]', value: '특정 지역의 감시를 재활성화합니다.\n예: `w!enablezone 서울`', inline: false },
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

    const getLinkButtons = () => {
    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setLabel('🎫 서포트 서버')
                .setStyle(ButtonStyle.Link)
                .setURL(SUPPORT_SERVER_URL),
            new ButtonBuilder()
                .setLabel('📊 실시간 대시보드')
                .setStyle(ButtonStyle.Link)
                .setURL(DASHBOARD_URL)
        );
    return row;
};

    // 초기 메시지 전송
    const helpMessage = await message.reply({
        embeds: [pages[currentPage]],
        components: [getButtons(currentPage), getLinkButtons()]
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
            components: [getButtons(currentPage), getLinkButtons()]  // ⭐ 배열에 추가
        });
    });

    collector.on('end', () => {
        // 5분 후 버튼 비활성화
        helpMessage.edit({
            embeds: [pages[currentPage]],
            components: [getLinkButtons()]
        }).catch(() => {}); // 메시지가 삭제된 경우 무시
    });
};
