/**
 * 游戏逻辑 V2（不固定 level）
 *
 * @author yupi https://github.com/liyupi
 */
import { useGlobalStore } from "./globalStore";
// @ts-ignore
import _ from "lodash";
import { ref } from "vue";

const useGame = () => {
  const { gameConfig } = useGlobalStore();

  // 游戏状态：0 - 初始化, 1 - 进行中, 2 - 失败结束, 3 - 胜利
  const gameStatus = ref(0);

  // 各层块
  const levelBlocksVal = ref<BlockType[]>([]);
  // 随机区块
  const randomBlocksVal = ref<BlockType[][]>([]);
  // 插槽区
  const slotAreaVal = ref<BlockType[]>([]);
  // 当前槽占用数
  const currSlotNum = ref(0);

  // 保存所有块（包括随机块）
  const allBlocks: BlockType[] = [];
  const blockData: Record<number, BlockType> = {};

  // 总块数
  let totalBlockNum = ref(0);

  // 已消除块数
  let clearBlockNum = ref(0);

  // 总共划分 24 x 24 的格子，每个块占 3 x 3 的格子，生成的起始 x 和 y 坐标范围均为 0 ~ 21
  const boxWidthNum = 24;
  const boxHeightNum = 24;

  // 每个格子的宽高
  const widthUnit = 14;
  const heightUnit = 14;

  // 保存整个 "棋盘" 的每个格子状态（下标为格子起始点横纵坐标）
  let chessBoard: ChessBoardUnitType[][] = [];

  // 操作历史（存储点击的块），使用 ref 保证重赋值后外部拿到的引用仍同步
  const opHistory = ref<BlockType[]>([]);

  // 操作历史快照（按块 id 记录点击前的双向遮挡关系，用于撤回时精确恢复）
  interface HistorySnapshot {
    // 点击时该块压住的下层块列表
    higherThanBlocks: BlockType[];
    // 点击时压住该块的上层块列表（圣光/破坏强制点击被压块时可能非空）
    lowerThanBlocks: BlockType[];
  }
  const historySnapshotMap = new Map<number, HistorySnapshot>();

  // region 技能相关

  const isHolyLight = ref(false);

  const canSeeRandom = ref(false);

  // endregion

  /**
   * 初始化指定大小的棋盘
   * @param width
   * @param height
   */
  const initChessBoard = (width: number, height: number) => {
    chessBoard = new Array(width);
    for (let i = 0; i < width; i++) {
      chessBoard[i] = new Array(height);
      for (let j = 0; j < height; j++) {
        chessBoard[i][j] = {
          blocks: [],
        };
      }
    }
  };

  // 初始化棋盘
  initChessBoard(boxWidthNum, boxHeightNum);

  /**
   * 游戏初始化
   */
  const initGame = () => {
    console.log("initGame", gameConfig);

    // 0. 设置父容器宽高
    const levelBoardDom: any = document.getElementsByClassName("level-board");
    levelBoardDom[0].style.width = widthUnit * boxWidthNum + "px";
    levelBoardDom[0].style.height = heightUnit * boxHeightNum + "px";

    // 1. 规划块数
    // 块数单位（总块数必须是该值的倍数）
    const blockNumUnit = gameConfig.composeNum * gameConfig.typeNum;
    console.log("块数单位", blockNumUnit);

    // 随机生成的总块数
    const totalRandomBlockNum = gameConfig.randomBlocks.reduce(
      (pre: number, curr: number) => {
        return pre + curr;
      },
      0
    );
    console.log("随机生成的总块数", totalRandomBlockNum);

    // 需要的最小块数
    const minBlockNum =
      gameConfig.levelNum * gameConfig.levelBlockNum + totalRandomBlockNum;
    console.log("需要的最小块数", minBlockNum);

    // 补齐到 blockNumUnit 的倍数
    // e.g. minBlockNum = 14, blockNumUnit = 6, 补到 18
    totalBlockNum.value = minBlockNum;
    if (totalBlockNum.value % blockNumUnit !== 0) {
      totalBlockNum.value =
        (Math.floor(minBlockNum / blockNumUnit) + 1) * blockNumUnit;
    }
    console.log("总块数", totalBlockNum.value);

    // 2. 初始化块，随机生成块的内容
    // 保存所有块的数组
    const animalBlocks: string[] = [];
    // 需要用到的动物数组
    const needAnimals = gameConfig.animals.slice(0, gameConfig.typeNum);
    // 依次把块塞到数组里
    for (let i = 0; i < totalBlockNum.value; i++) {
      animalBlocks.push(needAnimals[i % gameConfig.typeNum]);
    }
    // 打乱数组
    const randomAnimalBlocks = _.shuffle(animalBlocks);

    // 初始化
    for (let i = 0; i < totalBlockNum.value; i++) {
      const newBlock = {
        id: i,
        status: 0,
        level: 0,
        type: randomAnimalBlocks[i],
        higherThanBlocks: [] as BlockType[],
        lowerThanBlocks: [] as BlockType[],
      } as BlockType;
      allBlocks.push(newBlock);
    }

    // 下一个要塞入的块
    let pos = 0;

    // 3. 计算随机生成的块
    const randomBlocks: BlockType[][] = [];
    gameConfig.randomBlocks.forEach((randomBlock: number, idx: number) => {
      randomBlocks[idx] = [];
      for (let i = 0; i < randomBlock; i++) {
        randomBlocks[idx].push(allBlocks[pos]);
        blockData[pos] = allBlocks[pos];
        pos++;
      }
    });

    // 剩余块数
    let leftBlockNum = totalBlockNum.value - totalRandomBlockNum;

    // 4. 计算有层级关系的块
    const levelBlocks: BlockType[] = [];
    let minX = 0;
    let maxX = 22;
    let minY = 0;
    let maxY = 22;
    // 分为 gameConfig.levelNum 批，依次生成，每批的边界不同
    for (let i = 0; i < gameConfig.levelNum; i++) {
      let nextBlockNum = Math.min(gameConfig.levelBlockNum, leftBlockNum);
      // 最后一批，分配所有 leftBlockNum
      if (i == gameConfig.levelNum - 1) {
        nextBlockNum = leftBlockNum;
      }
      // 边界收缩
      if (gameConfig.borderStep > 0) {
        const dir = i % 4;
        if (i > 0) {
          if (dir === 0) {
            minX += gameConfig.borderStep;
          } else if (dir === 1) {
            maxY -= gameConfig.borderStep;
          } else if (dir === 2) {
            minY += gameConfig.borderStep;
          } else {
            maxX -= gameConfig.borderStep;
          }
        }
      }
      const nextGenBlocks = allBlocks.slice(pos, pos + nextBlockNum);
      levelBlocks.push(...nextGenBlocks);
      pos = pos + nextBlockNum;
      // 生成块的坐标
      genLevelBlockPos(nextGenBlocks, minX, minY, maxX, maxY);
      leftBlockNum -= nextBlockNum;
      if (leftBlockNum <= 0) {
        break;
      }
    }
    console.log("最终剩余块数", leftBlockNum);

    // 4. 初始化空插槽
    const slotArea: BlockType[] = new Array(gameConfig.slotNum).fill(null);
    console.log("随机块情况", randomBlocks);

    return {
      levelBlocks,
      randomBlocks,
      slotArea,
    };
  };

  /**
   * 生成一批层级块（坐标、层级关系）
   * @param blocks
   * @param minX
   * @param minY
   * @param maxX
   * @param maxY
   */
  const genLevelBlockPos = (
    blocks: BlockType[],
    minX: number,
    minY: number,
    maxX: number,
    maxY: number
  ) => {
    // 记录这批块的坐标，用于保证同批次元素不能完全重叠
    const currentPosSet = new Set<string>();
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      // 随机生成坐标
      let newPosX;
      let newPosY;
      let key;
      while (true) {
        newPosX = Math.floor(Math.random() * maxX + minX);
        newPosY = Math.floor(Math.random() * maxY + minY);
        key = newPosX + "," + newPosY;
        // 同批次元素不能完全重叠
        if (!currentPosSet.has(key)) {
          break;
        }
      }
      chessBoard[newPosX][newPosY].blocks.push(block);
      currentPosSet.add(key);
      block.x = newPosX;
      block.y = newPosY;
      // 填充层级关系
      genLevelRelation(block);
    }
  };

  /**
   * 给块绑定层级关系（用于确认哪些元素是当前可点击的）
   * 核心逻辑：每个块压住和其坐标有交集棋盘格内所有 level 大于它的点，双向建立联系
   * @param block
   */
  const genLevelRelation = (block: BlockType) => {
    // 确定该块附近的格子坐标范围
    const minX = Math.max(block.x - 2, 0);
    const minY = Math.max(block.y - 2, 0);
    const maxX = Math.min(block.x + 3, boxWidthNum - 2);
    const maxY = Math.min(block.y + 3, boxWidthNum - 2);
    // 遍历该块附近的格子
    let maxLevel = 0;
    for (let i = minX; i < maxX; i++) {
      for (let j = minY; j < maxY; j++) {
        const relationBlocks = chessBoard[i][j].blocks;
        if (relationBlocks.length > 0) {
          // 取当前位置最高层、且仍在棋盘上（未被点走/消除）的块
          let maxLevelRelationBlock: BlockType | undefined;
          for (let k = relationBlocks.length - 1; k >= 0; k--) {
            if (
              relationBlocks[k].status === 0 &&
              relationBlocks[k].id !== block.id
            ) {
              maxLevelRelationBlock = relationBlocks[k];
              break;
            }
          }
          if (!maxLevelRelationBlock) {
            continue;
          }
          maxLevel = Math.max(maxLevel, maxLevelRelationBlock.level);
          // 避免重复建立遮挡关系
          if (
            !block.higherThanBlocks.some(
              (relationBlock) => relationBlock.id === maxLevelRelationBlock!.id
            )
          ) {
            block.higherThanBlocks.push(maxLevelRelationBlock);
          }
          if (
            !maxLevelRelationBlock.lowerThanBlocks.some(
              (relationBlock) => relationBlock.id === block.id
            )
          ) {
            maxLevelRelationBlock.lowerThanBlocks.push(block);
          }
        }
      }
    }
    // 比最高层的块再高一层（初始为 1）
    block.level = maxLevel + 1;
  };

  /**
   * 点击块事件
   * @param block
   * @param randomIdx 随机区域下标，>= 0 表示点击的是随机块
   * @param force 强制移除
   */
  const doClickBlock = (block: BlockType, randomIdx = -1, force = false) => {
    // 已经输了 / 已经被点击 / 有上层块（且非强制和圣光），不能再点击
    if (
      currSlotNum.value >= gameConfig.slotNum ||
      block.status !== 0 ||
      (block.lowerThanBlocks.length > 0 && !force && !isHolyLight.value)
    ) {
      return;
    }
    isHolyLight.value = false;
    // 修改元素状态为已点击
    block.status = 1;
    // 移除当前元素
    if (randomIdx >= 0) {
      // 移除所点击的随机区域的第一个元素
      randomBlocksVal.value[randomIdx] = randomBlocksVal.value[randomIdx].slice(
        1,
        randomBlocksVal.value[randomIdx].length
      );
    } else {
      // 非随机区才可撤回：先快照点击前的双向遮挡关系
      opHistory.value.push(block);
      historySnapshotMap.set(block.id, {
        higherThanBlocks: [...block.higherThanBlocks],
        lowerThanBlocks: [...block.lowerThanBlocks],
      });
      // 移除该块的全部双向遮挡关系：
      // 1. 它压住的下层块不再被它压
      block.higherThanBlocks.forEach((higherThanBlock) => {
        _.remove(higherThanBlock.lowerThanBlocks, (lowerThanBlock) => {
          return lowerThanBlock.id === block.id;
        });
      });
      // 2. 压住它的上层块不再压住它（圣光/破坏强制点击被压块时尤其需要）
      block.lowerThanBlocks.forEach((lowerThanBlock) => {
        _.remove(lowerThanBlock.higherThanBlocks, (higherThanBlock) => {
          return higherThanBlock.id === block.id;
        });
      });
      // 双向关系已全部解除，块进入槽位期间不再持有任何遮挡引用，
      // 撤回时通过 historySnapshotMap 中的快照恢复
      block.higherThanBlocks = [];
      block.lowerThanBlocks = [];
    }
    // 新元素加入插槽
    let tempSlotNum = currSlotNum.value;
    slotAreaVal.value[tempSlotNum] = block;
    // 检查是否有可消除的
    // block => 出现次数
    const map: Record<string, number> = {};
    // 去除空槽
    const tempSlotAreaVal = slotAreaVal.value.filter(
      (slotBlock) => !!slotBlock
    );
    tempSlotAreaVal.forEach((slotBlock) => {
      const type = slotBlock.type;
      if (!map[type]) {
        map[type] = 1;
      } else {
        map[type]++;
      }
    });
    console.log("tempSlotAreaVal", tempSlotAreaVal);
    console.log("map", map);
    // 得到新数组
    const newSlotAreaVal = new Array(gameConfig.slotNum).fill(null);
    tempSlotNum = 0;
    tempSlotAreaVal.forEach((slotBlock) => {
      // 成功消除（不添加到新数组中）
      if (map[slotBlock.type] >= gameConfig.composeNum) {
        // 块状态改为已消除
        slotBlock.status = 2;
        // 已消除块数 +1
        clearBlockNum.value++;
        // 清除操作记录，防止撤回
        opHistory.value = [];
        historySnapshotMap.clear();
        return;
      }
      newSlotAreaVal[tempSlotNum++] = slotBlock;
    });
    slotAreaVal.value = newSlotAreaVal;
    currSlotNum.value = tempSlotNum;
    // 游戏结束
    if (tempSlotNum >= gameConfig.slotNum) {
      gameStatus.value = 2;
      setTimeout(() => {
        alert("你输了");
      }, 2000);
    }
    if (clearBlockNum.value >= totalBlockNum.value) {
      gameStatus.value = 3;
    }
  };

  /**
   * 开始游戏（重开时清空上一局的所有残留状态，保证干净一局）
   */
  const doStart = () => {
    // 重置所有局内状态
    gameStatus.value = 0;
    levelBlocksVal.value = [];
    randomBlocksVal.value = [];
    slotAreaVal.value = [];
    currSlotNum.value = 0;
    totalBlockNum.value = 0;
    clearBlockNum.value = 0;
    opHistory.value = [];
    historySnapshotMap.clear();
    isHolyLight.value = false;
    canSeeRandom.value = false;
    allBlocks.length = 0;
    Object.keys(blockData).forEach((key) => {
      delete blockData[Number(key)];
    });
    initChessBoard(boxWidthNum, boxHeightNum);

    const { levelBlocks, randomBlocks, slotArea } = initGame();
    console.log(levelBlocks, randomBlocks, slotArea);
    levelBlocksVal.value = levelBlocks;
    randomBlocksVal.value = randomBlocks;
    slotAreaVal.value = slotArea;
    gameStatus.value = 1;
  };

  // region 技能

  /**
   * 洗牌
   *
   * @desc 随机重洗所有未被点击的块
   */
  const doShuffle = () => {
    // 遍历所有未消除的块
    const originBlocks = allBlocks.filter((block) => block.status === 0);
    const newBlockTypes = _.shuffle(originBlocks.map((block) => block.type));
    let pos = 0;
    originBlocks.forEach((block) => {
      block.type = newBlockTypes[pos++];
    });
    levelBlocksVal.value = [...levelBlocksVal.value];
  };

  /**
   * 破坏
   *
   * @desc 消除一组层级块
   */
  const doBroke = () => {
    // 类型，块列表映射
    const typeBlockMap: Record<string, BlockType[]> = {};
    const blocks = levelBlocksVal.value.filter((block) => block.status === 0);
    // 遍历所有未消除的层级块
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (!typeBlockMap[block.type]) {
        typeBlockMap[block.type] = [];
      }
      typeBlockMap[block.type].push(block);
      // 有能消除的一组块
      if (typeBlockMap[block.type].length >= gameConfig.composeNum) {
        typeBlockMap[block.type].forEach((clickBlock) => {
          doClickBlock(clickBlock, -1, true);
        });
        console.log("doBroke", typeBlockMap[block.type]);
        break;
      }
    }
  };

  /**
   * 撤回
   *
   * @desc 后退一步：恢复块的双向遮挡关系与槽占用数。
   * 消除发生时操作历史会被清空，因此消除后的操作无法撤回，规则保持不变。
   */
  const doRevert = () => {
    if (opHistory.value.length < 1) {
      return;
    }
    const block = opHistory.value.pop()!;
    const snapshot = historySnapshotMap.get(block.id);
    // 从槽位移除该块并保持其余块紧凑排列
    const slotIndex = slotAreaVal.value.findIndex(
      (slotBlock) => slotBlock && slotBlock.id === block.id
    );
    if (slotIndex >= 0) {
      slotAreaVal.value.splice(slotIndex, 1);
      // @ts-ignore 槽位数组以 null 表示空槽
      slotAreaVal.value.push(null);
      // 该块仍在槽位中才回退占用数（理论上一定成立）
      currSlotNum.value = Math.max(currSlotNum.value - 1, 0);
    }
    // 块恢复为未点击
    block.status = 0;
    if (snapshot) {
      // 仅恢复当前仍在棋盘上（status=0）的关系块：
      // 快照中的块若已被点入槽位或已消除，则不再实际参与遮挡，
      // 不能让其继续压住/被压，否则会出现永久不可点或失效引用。
      // 恢复它压住的下层块关系：下层块重新被该块压住
      block.higherThanBlocks = snapshot.higherThanBlocks.filter(
        (higherThanBlock) => higherThanBlock.status === 0
      );
      block.higherThanBlocks.forEach((higherThanBlock) => {
        if (
          !higherThanBlock.lowerThanBlocks.some(
            (lowerThanBlock) => lowerThanBlock.id === block.id
          )
        ) {
          higherThanBlock.lowerThanBlocks.push(block);
        }
      });
      // 恢复压住它的上层块关系：该块重新被这些仍在棋盘上的上层块压住
      block.lowerThanBlocks = snapshot.lowerThanBlocks.filter(
        (lowerThanBlock) => lowerThanBlock.status === 0
      );
      block.lowerThanBlocks.forEach((lowerThanBlock) => {
        if (
          !lowerThanBlock.higherThanBlocks.some(
            (higherThanBlock) => higherThanBlock.id === block.id
          )
        ) {
          lowerThanBlock.higherThanBlocks.push(block);
        }
      });
      historySnapshotMap.delete(block.id);
    } else {
      // 兜底：无快照时清空旧关系后按当前棋盘重建遮挡关系
      block.higherThanBlocks = [];
      block.lowerThanBlocks = [];
      genLevelRelation(block);
    }
  };

  /**
   * 从棋盘上彻底摘除一个块的双向遮挡关系
   * @param block
   */
  const detachBlockRelations = (block: BlockType) => {
    // 它压住的下层块不再被它压
    block.higherThanBlocks.forEach((higherThanBlock) => {
      _.remove(higherThanBlock.lowerThanBlocks, (lowerThanBlock) => {
        return lowerThanBlock.id === block.id;
      });
    });
    // 压住它的上层块不再压住它
    block.lowerThanBlocks.forEach((lowerThanBlock) => {
      _.remove(lowerThanBlock.higherThanBlocks, (higherThanBlock) => {
        return higherThanBlock.id === block.id;
      });
    });
    block.higherThanBlocks = [];
    block.lowerThanBlocks = [];
  };

  /**
   * 在棋盘中寻找一个未被占用的格子坐标。
   * 每个块占 3 x 3 个格子，因此候选坐标覆盖的 9 个格子都必须无在棋盘块，
   * 否则两个块即使锚点不同也会在棋盘上发生重叠。
   * 在棋盘块指未被点入槽位的块（status=0 活跃、status=2 已消除占位）；
   * status=1 的块已在槽位中、不在棋盘。
   * 注意：chessBoard 只记录块的锚点格，因此这里直接按每个在棋盘块的
   * 3 x 3 实际占位计算，避免锚点不同但几何重叠。
   * 找不到时返回 null（极端情况）
   */
  const findEmptyChessPos = (
    selfBlock: BlockType
  ): { x: number; y: number } | null => {
    // 收集所有其他在棋盘块的 3 x 3 占位区间
    const onBoardBlocks = allBlocks.filter(
      (chessBlock) =>
        chessBlock.id !== selfBlock.id &&
        chessBlock.status !== 1 &&
        typeof chessBlock.x === "number" &&
        typeof chessBlock.y === "number"
    );
    const candidates: { x: number; y: number }[] = [];
    for (let x = 0; x <= boxWidthNum - 3; x++) {
      for (let y = 0; y <= boxHeightNum - 3; y++) {
        let overlap = false;
        for (const other of onBoardBlocks) {
          const xOverlap = x < other.x + 3 && other.x < x + 3;
          const yOverlap = y < other.y + 3 && other.y < y + 3;
          if (xOverlap && yOverlap) {
            overlap = true;
            break;
          }
        }
        if (!overlap) {
          candidates.push({ x, y });
        }
      }
    }
    if (candidates.length === 0) {
      return null;
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
  };

  /**
   * 移出块
   *
   * @desc 把槽位第一个块放回棋盘，重建遮挡关系并保证坐标不与已有块重叠
   */
  const doRemove = () => {
    // 移除第一个块
    const block = slotAreaVal.value[0];
    if (!block) {
      return;
    }
    // 槽移除块并保持紧凑（splice 后补一个空槽，长度不变）
    slotAreaVal.value.splice(0, 1);
    // @ts-ignore 槽位数组以 null 表示空槽
    slotAreaVal.value.push(null);
    // 槽占用数回退
    currSlotNum.value = Math.max(currSlotNum.value - 1, 0);
    // 该块已离开槽位，其点击历史不能再用于撤回
    const historyIndex = opHistory.value.findIndex(
      (historyBlock) => historyBlock.id === block.id
    );
    if (historyIndex >= 0) {
      opHistory.value.splice(historyIndex, 1);
      historySnapshotMap.delete(block.id);
    }
    // 从旧的棋盘格子中摘除（层级块被点走时仍保留在 chessBoard 中）
    if (
      typeof block.x === "number" &&
      typeof block.y === "number" &&
      chessBoard[block.x]?.[block.y]
    ) {
      _.remove(
        chessBoard[block.x][block.y].blocks,
        (chessBlock) => chessBlock.id === block.id
      );
    }
    // 清理旧的双向遮挡关系（此时块仍是 status=1，寻找空位时不会被误判为在棋盘）
    detachBlockRelations(block);
    // 寻找不会落到其他在棋盘块上的新坐标（自身已排除）
    const emptyPos = findEmptyChessPos(block);
    if (emptyPos) {
      block.x = emptyPos.x;
      block.y = emptyPos.y;
    } else {
      // 兜底：随机坐标（棋盘被占满时几乎不会发生）
      block.x = Math.floor(Math.random() * (boxWidthNum - 2));
      block.y = Math.floor(Math.random() * (boxHeightNum - 2));
    }
    // 放回棋盘、恢复为在棋盘状态并重建遮挡关系
    block.status = 0;
    chessBoard[block.x][block.y].blocks.push(block);
    genLevelRelation(block);
    // 随机区移回的块需要加入层级区域参与渲染与判定
    if (
      !levelBlocksVal.value.some((levelBlock) => levelBlock.id === block.id)
    ) {
      levelBlocksVal.value = [...levelBlocksVal.value, block];
    }
  };

  /**
   * 圣光
   *
   * @desc 下一个块可以任意点击
   */
  const doHolyLight = () => {
    isHolyLight.value = true;
  };

  /**
   * 透视
   *
   * @desc 可以看到随机块
   */
  const doSeeRandom = () => {
    canSeeRandom.value = !canSeeRandom.value;
  };

  // endregion

  return {
    gameStatus,
    levelBlocksVal,
    randomBlocksVal,
    slotAreaVal,
    widthUnit,
    heightUnit,
    currSlotNum,
    opHistory,
    totalBlockNum,
    clearBlockNum,
    isHolyLight,
    canSeeRandom,
    doClickBlock,
    doStart,
    doShuffle,
    doBroke,
    doRemove,
    doRevert,
    doHolyLight,
    doSeeRandom,
  };
};

export default useGame;
