// shared/upgrades.js — upgrade metadata + apply/available logic used by both server and client

const { PLAYER_SPEED, BULLET_SPEED } = require("./constants");

const UPGRADE_DEFS = [
  {
    id: "damage",
    title: "Тяжёлая пуля",
    description: "Увеличивает урон ваших патронов на +100 за уровень.",
    bonus(player, power) {
      return `+${100 * power} к урону`;
    }
  },

  {
    id: "bounce",
    title: "Дополнительный рикошет",
    description: "Ваши патроны могут дополнительно отскакивать от стен.",
    bonus(player, power) {
      return `+${power} к количеству рикошетов`;
    }
  },

  {
    id: "pierce",
    title: "Пробитие",
    description: "Ваши патроны пробивают дополнительные цели.",
    available(player) {
      const hasAoe = (player.stats?.explosionRadius || 0) > 0 ||
                     (player.stats?.chainCount || 0) > 0 ||
                     (player.stats?.catchBlast || 0) > 0;
      return !hasAoe;
    },
    bonus(player, power) {
      return `+${power} к количеству пробиваемых целей`;
    }
  },

  {
    id: "bullet-speed",
    title: "Разогнанный ствол",
    description: "Увеличивает скорость ваших патронов на +25% за уровень (макс. 250%).",
    available(player) {
      return (player.stats?.bulletSpeed || BULLET_SPEED) < BULLET_SPEED * 2.5 - 1;
    },
    bonus(player, power) {
      const current = player.stats?.bulletSpeed || BULLET_SPEED;
      const maxSpeed = BULLET_SPEED * 2.5;
      const requested = BULLET_SPEED * 0.25 * power;
      const result = Math.min(maxSpeed, current + requested);
      const actual = result - current;
      const actualPct = Math.round((actual / BULLET_SPEED) * 100);
      const totalPct = Math.round((result / BULLET_SPEED) * 100);
      return `+${actualPct}% к скорости патрона (итог: ${totalPct}%, макс. 250%)`;
    }
  },

  {
    id: "move-speed",
    title: "Лёгкие ботинки",
    description: "Увеличивает скорость передвижения.",
    bonus(player, power) {
      return `+${12 * power}% к скорости движения`;
    }
  },

  {
    id: "armor",
    title: "Усиленная броня",
    description: "Повышает максимальное и текущее здоровье на +100 за уровень.",
    bonus(player, power) {
      return `+${100 * power} к максимальному и текущему здоровью`;
    }
  },

  {
    id: "repair",
    title: "Ремонтный комплект",
    description: "Полностью восстанавливает текущее здоровье.",
    fixedRarity: "common",
    available(player) {
      return player.hp < player.maxHp;
    },
    bonus(player) {
      return `+${Math.max(0, player.maxHp - player.hp)} HP (полное восстановление)`;
    }
  },

  {
    id: "critical",
    title: "Критический механизм",
    description: "Повышает шанс нанести критический урон x2.0 (макс. 60%).",
    available(player) {
      return player.stats.critChance < 0.6;
    },
    bonus(player, power) {
      const current = player.stats.critChance || 0;
      const result = Math.min(0.6, current + 0.10 * power);
      const actual = Math.max(0, result - current);
      return `+${Math.round(actual * 100)}% к шансу крита (x2.0, итог: ${Math.round(result * 100)}%)`;
    }
  },

  {
    id: "resilience",
    title: "Стойкость",
    description: "Снижает получаемый урон в процентах (макс. 42%).",
    available(player) {
      return (player.stats.damageResistance || 0) < 0.42;
    },
    bonus(player, power) {
      const current = player.stats.damageResistance || 0;
      const result = Math.min(0.42, current + 0.06 * power);
      const actual = Math.max(0, result - current);
      return `+${Math.round(actual * 100)}% к сопротивлению урону (итог: ${Math.round(result * 100)}%)`;
    }
  },

  {
    id: "caliber",
    title: "Крупный калибр",
    description: "Увеличивает размер ваших патронов, облегчая попадание.",
    available(player) {
      return player.stats.bulletRadius < 15;
    },
    bonus(player, power) {
      const result = Math.min(15, player.stats.bulletRadius + 1.5 * power);
      return `+${(result - player.stats.bulletRadius).toFixed(1)} px к радиусу патрона (итог: ${result.toFixed(1)} px)`;
    }
  },

  {
    id: "second-bullet",
    title: "Запасной патрон",
    description: "Добавляет второй независимый патрон в магазин.",
    fixedRarity: "rare",
    available(player) {
      return player.stats.magazineSize < 2;
    },
    bonus() {
      return "+1 независимый патрон (всего 2)";
    }
  },

  {
    id: "catch-blast",
    title: "Импульсный захват",
    description: "Пойманная пуля создает импульсную волну, наносящую урон ближайшим врагам.",
    fixedRarity: "rare",
    available(player) {
      return (player.stats?.pierce || 0) <= 0 && (player.stats?.catchBlast || 0) === 0;
    },
    bonus(player, power) {
      const result = 65 * power;
      return `Волна радиусом ${result}px (80% урона пули)`;
    }
  },

  {
    id: "catch-blast-damage",
    title: "Сила импульса",
    description: "Увеличивает урон импульсной волны при ловле пули на +35% (макс. 250% урона пули).",
    available(player) {
      return Boolean((player.stats?.catchBlast || 0) > 0) && (player.stats?.catchBlastDamageRatio || 0.8) < 2.5;
    },
    bonus(player, power) {
      const current = player.stats?.catchBlastDamageRatio || 0.8;
      const result = Math.min(2.5, current + 0.35 * power);
      return `+${Math.round((result - current) * 100)}% к урону волны (итог: ${Math.round(result * 100)}%)`;
    }
  },

  {
    id: "catch-blast-radius",
    title: "Радиус импульса",
    description: "Увеличивает радиус поражения импульсной волны на +30px (макс. 220px).",
    available(player) {
      return Boolean((player.stats?.catchBlast || 0) > 0) && (player.stats?.catchBlast || 65) < 220;
    },
    bonus(player, power) {
      const current = player.stats?.catchBlast || 65;
      const result = Math.min(220, current + 30 * power);
      return `+${result - current}px к радиусу волны (итог: ${result}px)`;
    }
  },

  {
    id: "emergency-repair",
    title: "Аварийный ремонт",
    description: "Убийства периодически восстанавливают +100 здоровья (макс. каждые 8 убийств).",
    available(player) {
      return (player.stats?.healEvery || 0) === 0 || player.stats.healEvery > 8;
    },
    bonus(player, power) {
      const current = player.stats?.healEvery || 0;
      let nextVal = 16;
      if (current === 0) {
        nextVal = power >= 3 ? 12 : power >= 2 ? 14 : 16;
      } else {
        nextVal = Math.max(8, current - (power >= 3 ? 4 : power >= 2 ? 3 : 2));
      }
      return `Лечение +100 HP каждые ${nextVal} убийств (макс. 8)`;
    }
  },

  {
    id: "explosive",
    title: "Разрывной сердечник",
    description: "Попадание создаёт взрыв, наносящий урон соседним врагам.",
    fixedRarity: "rare",
    available(player) {
      return (player.stats?.pierce || 0) <= 0 && (player.stats?.explosionRadius || 0) === 0;
    },
    bonus(player, power) {
      const result = 40 * power;
      return `Взрыв радиусом ${result}px (60% урона пули)`;
    }
  },

  {
    id: "explosion-damage",
    title: "Ударная волна",
    description: "Увеличивает урон взрыва пули на +25% (макс. 160% урона пули).",
    available(player) {
      return Boolean((player.stats?.explosionRadius || 0) > 0) && (player.stats?.explosionDamageRatio || 0.6) < 1.6;
    },
    bonus(player, power) {
      const current = player.stats?.explosionDamageRatio || 0.6;
      const result = Math.min(1.6, current + 0.25 * power);
      return `+${Math.round((result - current) * 100)}% к урону взрыва (итог: ${Math.round(result * 100)}%)`;
    }
  },

  {
    id: "explosion-radius",
    title: "Радиус детонации",
    description: "Увеличивает радиус взрыва пули на +30px (макс. 180px).",
    available(player) {
      return Boolean((player.stats?.explosionRadius || 0) > 0) && (player.stats?.explosionRadius || 40) < 180;
    },
    bonus(player, power) {
      const current = player.stats?.explosionRadius || 40;
      const result = Math.min(180, current + 30 * power);
      return `+${result - current}px к радиусу взрыва (итог: ${result}px)`;
    }
  },

  {
    id: "chain-lightning",
    title: "Цепной конденсатор",
    description: "Попадание выпускает цепной разряд в ближайших врагов.",
    fixedRarity: "rare",
    available(player) {
      return (player.stats?.pierce || 0) <= 0 && (player.stats?.chainCount || 0) === 0;
    },
    bonus(player, power) {
      const count = 2 * power;
      return `Цепь из ${count} дуг (60% урона пули)`;
    }
  },

  {
    id: "lightning-damage",
    title: "Мощность разряда",
    description: "Увеличивает урон цепной молнии на +25% (макс. 200% урона пули).",
    available(player) {
      return Boolean((player.stats?.chainCount || 0) > 0) && (player.stats?.chainDamageRatio || 0.6) < 2.0;
    },
    bonus(player, power) {
      const current = player.stats?.chainDamageRatio || 0.6;
      const result = Math.min(2.0, current + 0.25 * power);
      return `+${Math.round((result - current) * 100)}% к урону молнии (итог: ${Math.round(result * 100)}%)`;
    }
  },

  {
    id: "lightning-targets",
    title: "Проводники цепи",
    description: "Увеличивает количество поражаемых цепной молнией врагов на +2 (макс. 9).",
    available(player) {
      return Boolean((player.stats?.chainCount || 0) > 0) && (player.stats?.chainCount || 2) < 9;
    },
    bonus(player, power) {
      const current = player.stats?.chainCount || 2;
      const result = Math.min(9, current + 2 * power);
      return `+${result - current} цели для молнии (итог: ${result})`;
    }
  },

  {
    id: "lightning-range",
    title: "Радиус дуги",
    description: "Увеличивает максимальную дистанцию перескока цепной молнии на +30px (макс. 260px).",
    available(player) {
      return Boolean((player.stats?.chainCount || 0) > 0) && (player.stats?.chainRange || 140) < 260;
    },
    bonus(player, power) {
      const current = player.stats?.chainRange || 140;
      const result = Math.min(260, current + 30 * power);
      return `+${result - current}px к радиусу перескока (итог: ${result}px)`;
    }
  },

  {
    id: "homing",
    title: "Умная пуля",
    description: "Пуля корректирует траекторию в сторону ближайшей цели.",
    bonus(player, power) {
      const current = (player.stats.homing || 0) + power;
      return `+${power} к силе наведения (итог: ${current})`;
    }
  },

  {
    id: "boomerang",
    title: "Эффект Бумеранга",
    description: "Пуля автоматически притягивается к владельцу (100 px/с, радиус 20 кл).",
    fixedRarity: "rare",
    available(player) {
      return !player.stats?.boomerang;
    },
    bonus() {
      return `Магнитный возврат: 100 px/с, радиус 20 клеток`;
    }
  },

  {
    id: "boomerang-damage",
    title: "Тяжёлый бумеранг",
    description: "Возвращающаяся пуля наносит урон врагам на пути (+25% за уровень, макс. 150%).",
    available(player) {
      return Boolean(player.stats?.boomerang) && (player.stats?.boomerangPercent || 0) < 1.5;
    },
    bonus(player, power) {
      const current = player.stats?.boomerangPercent || 0;
      const result = Math.min(1.5, current + 0.25 * power);
      return `+${Math.round((result - current) * 100)}% к урону бумеранга (итог: ${Math.round(result * 100)}%)`;
    }
  },

  {
    id: "boomerang-speed",
    title: "Турбо-магнит",
    description: "Увеличивает скорость притягивания пули на +100 px/с (макс. 600 px/с).",
    available(player) {
      return Boolean(player.stats?.boomerang) && (player.stats?.groundPullSpeed || 100) < 600;
    },
    bonus(player, power) {
      const current = player.stats?.groundPullSpeed || 100;
      const result = Math.min(600, current + 100 * power);
      return `+${result - current} px/с к скорости возврата (итог: ${result} px/с)`;
    }
  },

  {
    id: "boomerang-range",
    title: "Дальний захват",
    description: "Увеличивает радиус притягивания пули на +5 клеток (макс. 50 кл).",
    available(player) {
      return Boolean(player.stats?.boomerang) && (player.stats?.magnetRangeBonusCells || 0) < 30;
    },
    bonus(player, power) {
      const current = player.stats?.magnetRangeBonusCells || 0;
      const result = Math.min(30, current + 5 * power);
      return `+${result - current} кл. к радиусу захвата (итог: ${20 + result} кл.)`;
    }
  },

  {
    id: "splinter",
    title: "Осколочный Рикошет",
    description: "При рикошете от стены выпускает самонаводящийся осколок (25% урона пули, 1.5с).",
    fixedRarity: "rare",
    available(player) {
      return !player.stats?.splinter;
    },
    bonus(player, power) {
      const dmg = Math.round((player.stats?.damage || 100) * 0.25);
      return `1 осколок по ${dmg} урона (25%) при рикошете`;
    }
  },

  {
    id: "splinter-count",
    title: "Количество осколков",
    description: "Увеличивает количество осколков при каждом рикошете (макс. 5).",
    available(player) {
      return Boolean(player.stats?.splinter) && (player.stats?.splinterCount || 1) < 5;
    },
    bonus(player, power) {
      const current = player.stats?.splinterCount || 1;
      const result = Math.min(5, current + 1 * power);
      return `+${result - current} осколка при рикошете (итог: ${result})`;
    }
  },

  {
    id: "splinter-damage",
    title: "Урон осколков",
    description: "Увеличивает урон самонаводящихся осколков на +15% (макс. 100% урона пули).",
    available(player) {
      return Boolean(player.stats?.splinter) && (player.stats?.splinterDamagePercent || 0.25) < 1.0;
    },
    bonus(player, power) {
      const current = player.stats?.splinterDamagePercent || 0.25;
      const result = Math.min(1.0, current + 0.15 * power);
      return `+${Math.round((result - current) * 100)}% к урону осколков (итог: ${Math.round(result * 100)}%)`;
    }
  },

  {
    id: "stun",
    title: "Кинетический Удар",
    description: "Попадание с шансом 10% оглушает врага на 0.4с.",
    fixedRarity: "rare",
    available(player) {
      return !player.stats?.stun && (player.stats?.stunChance || 0) === 0;
    },
    bonus(player, power) {
      return `10% шанс оглушения на 0.4с (прерывает атаки)`;
    }
  },

  {
    id: "stun-chance",
    title: "Частота оглушения",
    description: "Увеличивает шанс оглушения врагов на +8% (макс. 45%).",
    available(player) {
      return Boolean(player.stats?.stun) && (player.stats?.stunChance || 0.10) < 0.45;
    },
    bonus(player, power) {
      const current = player.stats?.stunChance || 0.10;
      const result = Math.min(0.45, current + 0.08 * power);
      return `+${Math.round((result - current) * 100)}% к шансу оглушения (итог: ${Math.round(result * 100)}%)`;
    }
  },

  {
    id: "stun-duration",
    title: "Глубокий шок",
    description: "Увеличивает длительность оглушения на +0.3с (макс. 1.5с).",
    available(player) {
      return Boolean(player.stats?.stun) && (player.stats?.stunDuration || 0.4) < 1.5;
    },
    bonus(player, power) {
      const current = player.stats?.stunDuration || 0.4;
      const result = Number(Math.min(1.5, current + 0.3 * power).toFixed(1));
      return `+${Number((result - current).toFixed(1))}с к длительности стана (итог: ${result}с)`;
    }
  },

  {
    id: "reactive-armor",
    title: "Реактивная Броня",
    description: "При получении урона — импульсный взрыв 120px, отбрасывающий врагов (перезарядка 3с).",
    fixedRarity: "rare",
    available(player) {
      return !player.stats?.reactiveArmor;
    },
    bonus(player, power) {
      return `Взрыв 120px при уроне, кулдаун 3с`;
    }
  },

  {
    id: "reactive-armor-radius",
    title: "Область отражения",
    description: "Увеличивает радиус защитного импульса брони на +30px (макс. 210px).",
    available(player) {
      return Boolean(player.stats?.reactiveArmor) && (player.stats?.reactiveArmorRadius || 120) < 210;
    },
    bonus(player, power) {
      const current = player.stats?.reactiveArmorRadius || 120;
      const result = Math.min(210, current + 30 * power);
      return `+${result - current}px к радиусу импульса (итог: ${result}px)`;
    }
  },

  {
    id: "reactive-armor-cooldown",
    title: "Быстрая перезарядка",
    description: "Уменьшает время перезарядки реактивной брони на -0.5с (мин. 1.5с).",
    available(player) {
      return Boolean(player.stats?.reactiveArmor) && (player.stats?.reactiveArmorCooldownBase || 3.0) > 1.5;
    },
    bonus(player, power) {
      const current = player.stats?.reactiveArmorCooldownBase || 3.0;
      const result = Number(Math.max(1.5, current - 0.5 * power).toFixed(1));
      return `-${Number((current - result).toFixed(1))}с перезарядки (итог: ${result}с)`;
    }
  },

  {
    id: "poison",
    title: "Ядовитая пуля",
    description: "Пуля отравляет врагов (50% урона игрока/с в течение 2.0с).",
    fixedRarity: "rare",
    available(player) {
      return !player.stats?.poison;
    },
    bonus() {
      return "Отравление: 50% урона игрока/с на 2.0с";
    }
  },

  {
    id: "poison-damage",
    title: "Урон яда",
    description: "Увеличивает периодический урон яда на +50% урона игрока/с (макс. 500%).",
    available(player) {
      return Boolean(player.stats?.poison) && (player.stats?.poisonDamageRatio || 0.5) < 5.0;
    },
    bonus(player, power) {
      const current = player.stats?.poisonDamageRatio || 0.5;
      const result = Number(Math.min(5.0, current + 0.5 * power).toFixed(2));
      return `+${Math.round((result - current) * 100)}% к урону яда (итог: ${Math.round(result * 100)}% урона игрока/с)`;
    }
  },

  {
    id: "poison-duration",
    title: "Длительность яда",
    description: "Увеличивает длительность действия яда на +1.0с (макс. 5.0с).",
    available(player) {
      return Boolean(player.stats?.poison) && (player.stats?.poisonDuration || 2.0) < 5.0;
    },
    bonus(player, power) {
      const current = player.stats?.poisonDuration || 2.0;
      const result = Number(Math.min(5.0, current + 1.0 * power).toFixed(1));
      return `+${Number((result - current).toFixed(1))}с к длительности яда (итог: ${result}с)`;
    }
  },

  {
    id: "parasite",
    title: "Пуля с паразитом",
    description: "Выстрел с шансом 25% заражает врага. При гибели вылетает спора (75% урона игрока).",
    fixedRarity: "rare",
    available(player) {
      return !player.stats?.parasite;
    },
    bonus() {
      return "25% шанс паразита, 1 спора на 75% урона игрока";
    }
  },

  {
    id: "parasite-chance",
    title: "Шанс паразита",
    description: "Увеличивает шанс заражения паразитом на +5% (макс. 50%).",
    available(player) {
      return Boolean(player.stats?.parasite) && (player.stats?.parasiteChance || 0.25) < 0.50;
    },
    bonus(player, power) {
      const current = player.stats?.parasiteChance || 0.25;
      const result = Math.min(0.50, current + 0.05 * power);
      return `+${Math.round((result - current) * 100)}% к шансу паразита (итог: ${Math.round(result * 100)}%)`;
    }
  },

  {
    id: "parasite-count",
    title: "Количество паразитов",
    description: "Увеличивает количество вылетающих спор паразита при смерти врага на +1 (макс. 5).",
    available(player) {
      return Boolean(player.stats?.parasite) && (player.stats?.parasiteCount || 1) < 5;
    },
    bonus(player, power) {
      const current = player.stats?.parasiteCount || 1;
      const result = Math.min(5, current + 1 * power);
      return `+${result - current} паразита при гибели (итог: ${result})`;
    }
  },

  {
    id: "parasite-damage",
    title: "Урон паразита",
    description: "Увеличивает урон каждой споры паразита на +50% урона игрока (макс. 400%).",
    available(player) {
      return Boolean(player.stats?.parasite) && (player.stats?.parasiteDamageRatio || 0.75) < 4.0;
    },
    bonus(player, power) {
      const current = player.stats?.parasiteDamageRatio || 0.75;
      const result = Number(Math.min(4.0, current + 0.5 * power).toFixed(2));
      return `+${Math.round((result - current) * 100)}% к урону паразита (итог: ${Math.round(result * 100)}% урона игрока)`;
    }
  },

  {
    id: "target-mark",
    title: "Метка Цели",
    description: "Первое попадание помечает врага на 4с (+40% входящего урона).",
    fixedRarity: "rare",
    available(player) {
      return !player.stats?.targetMark && (player.stats?.markBonus || 0) === 0;
    },
    bonus(player, power) {
      return `+40% урона по помеченному врагу на 4с`;
    }
  },

  {
    id: "mark-amplification",
    title: "Уязвимость",
    description: "Увеличивает бонус урона по помеченной цели на +15% (макс. +80%).",
    available(player) {
      return Boolean(player.stats?.targetMark) && (player.stats?.markBonus || 0.40) < 0.80;
    },
    bonus(player, power) {
      const current = player.stats?.markBonus || 0.40;
      const result = Math.min(0.80, current + 0.15 * power);
      return `+${Math.round((result - current) * 100)}% к бонусу метки (итог: +${Math.round(result * 100)}%)`;
    }
  },

  {
    id: "mark-duration",
    title: "Глубокая метка",
    description: "Увеличивает длительность метки цели на +2.0с (макс. 10.0с).",
    available(player) {
      return Boolean(player.stats?.targetMark) && (player.stats?.markDuration || 4.0) < 10.0;
    },
    bonus(player, power) {
      const current = player.stats?.markDuration || 4.0;
      const result = Number(Math.min(10.0, current + 2.0 * power).toFixed(1));
      return `+${Number((result - current).toFixed(1))}с к длительности метки (итог: ${result}с)`;
    }
  },

  {
    id: "dash",
    title: "Рывок",
    description: "Мгновенный рывок с неуязвимостью (120px, 10с перезарядка).",
    fixedRarity: "rare",
    available(player) {
      return !player.stats?.dash;
    },
    bonus() {
      return `Рывок: 120px, кд 10с, неуязвимость`;
    }
  },

  {
    id: "dash-distance",
    title: "Дальность рывка",
    description: "Увеличивает дистанцию рывка на +50px (макс. 320px).",
    available(player) {
      return Boolean(player.stats?.dash) && (player.stats?.dashDistance || 120) < 320;
    },
    bonus(player, power) {
      const current = player.stats?.dashDistance || 120;
      const result = Math.min(320, current + 50 * power);
      return `+${result - current}px к дистанции рывка (итог: ${result}px)`;
    }
  },

  {
    id: "dash-cooldown",
    title: "Перезарядка рывка",
    description: "Уменьшает перезарядку рывка на -1.5с (мин. 2.0с).",
    available(player) {
      return Boolean(player.stats?.dash) && (player.stats?.dashCooldownBase || 10.0) > 2.0;
    },
    bonus(player, power) {
      const current = player.stats?.dashCooldownBase || 10.0;
      const result = Number(Math.max(2.0, current - 1.5 * power).toFixed(1));
      return `-${Number((current - result).toFixed(1))}с перезарядки (итог: ${result}с)`;
    }
  },

  {
    id: "dash-damage",
    title: "Разящий рывок",
    description: "Рывок наносит 100% урона всем врагам на пути.",
    fixedRarity: "legendary",
    available(player) {
      return Boolean(player.stats?.dash) && !player.stats?.dashDamage;
    },
    bonus(player) {
      return `Урон ${player.stats?.damage || 100} по врагам на пути рывка`;
    }
  },

  {
    id: "resurrection",
    title: "Воскрешение",
    description: "Одноразовый шанс встать после гибели. При смерти появится промпт — нажмите Пробел 5 раз за 5 секунд.",
    fixedRarity: "legendary",
    available(player) {
      return !player.stats?.resurrection && !player.stats?.resurrectionUsed;
    },
    bonus() {
      return "Воскрешение с 100 HP (одноразовое)";
    }
  }
];

function findUpgradeDef(id) {
  return UPGRADE_DEFS.find(def => def.id === id);
}

function isUpgradeAvailable(player, id) {
  const def = findUpgradeDef(id);
  if (!def) return false;
  return def.available ? def.available(player) : true;
}

function applyUpgrade(player, id, power = 1) {
  switch (id) {
    case "damage":
      player.stats.damage += 100 * power;
      break;

    case "bounce":
      player.stats.maxBounces += power;
      break;

    case "pierce":
      player.stats.pierce += power;
      break;

    case "bullet-speed":
      player.stats.bulletSpeed = Math.min(
        BULLET_SPEED * 2.5,
        (player.stats.bulletSpeed || BULLET_SPEED) +
          BULLET_SPEED * 0.25 * power
      );
      break;

    case "move-speed":
      player.stats.playerSpeed +=
        PLAYER_SPEED *
        0.12 *
        power;
      break;

    case "armor":
      player.maxHp += 100 * power;
      player.hp += 100 * power;
      break;

    case "repair":
      player.hp = player.maxHp;
      break;

    case "pickup":
    case "magnetic-field":
      player.stats.pickupRadius = 0;
      player.stats.groundPullSpeed =
        (player.stats.groundPullSpeed || 0) +
        110 * power;
      break;

    case "critical":
      player.stats.critChance = Math.min(0.6, (player.stats.critChance || 0) + 0.10 * power);
      break;

    case "resilience":
      player.stats.damageResistance = Math.min(0.42, (player.stats.damageResistance || 0) + 0.06 * power);
      break;

    case "caliber":
      player.stats.bulletRadius =
        Math.min(
          15,
          player.stats.bulletRadius +
            1.5 * power
        );
      break;

    case "second-bullet":
      player.stats.magazineSize = 2;
      break;

    case "homing":
      player.stats.homing = (player.stats.homing || 0) + power;
      break;

    case "catch-blast":
      player.stats.catchBlast = (player.stats.catchBlast || 0) + 65 * power;
      player.stats.catchBlastDamageRatio = player.stats.catchBlastDamageRatio || 0.8;
      break;

    case "catch-blast-damage":
      player.stats.catchBlastDamageRatio = Math.min(2.5, (player.stats.catchBlastDamageRatio || 0.8) + 0.35 * power);
      break;

    case "catch-blast-radius":
      player.stats.catchBlast = Math.min(220, (player.stats.catchBlast || 65) + 30 * power);
      break;

    case "emergency-repair": {
      const current = player.stats.healEvery || 0;
      if (current === 0) {
        player.stats.healEvery = power >= 3 ? 12 : power >= 2 ? 14 : 16;
      } else {
        player.stats.healEvery = Math.max(8, current - (power >= 3 ? 4 : power >= 2 ? 3 : 2));
      }
      player.stats.repairKillProgress = Math.min(
        player.stats.repairKillProgress || 0,
        Math.max(0, player.stats.healEvery - 1)
      );
      break;
    }

    case "explosive":
      player.stats.explosionRadius = (player.stats.explosionRadius || 0) + 40 * power;
      player.stats.explosionDamageRatio = player.stats.explosionDamageRatio || 0.6;
      break;

    case "explosion-damage":
      player.stats.explosionDamageRatio = Math.min(1.6, (player.stats.explosionDamageRatio || 0.6) + 0.25 * power);
      break;

    case "explosion-radius":
      player.stats.explosionRadius = Math.min(180, (player.stats.explosionRadius || 40) + 30 * power);
      break;

    case "chain-lightning":
      player.stats.chainCount = (player.stats.chainCount || 0) + 2 * power;
      player.stats.chainRange = player.stats.chainRange || 140;
      player.stats.chainDamageRatio = player.stats.chainDamageRatio || 0.6;
      break;

    case "lightning-damage":
      player.stats.chainDamageRatio = Math.min(2.0, (player.stats.chainDamageRatio || 0.6) + 0.25 * power);
      break;

    case "lightning-targets":
      player.stats.chainCount = Math.min(9, (player.stats.chainCount || 2) + 2 * power);
      break;

    case "lightning-range":
      player.stats.chainRange = Math.min(260, (player.stats.chainRange || 140) + 30 * power);
      break;

    case "recall-magnet":
      // Legacy: kept for backward compatibility with old saves
      player.stats.boomerang = true;
      player.stats.groundPullSpeed = Math.min(600, (player.stats.groundPullSpeed || 0) + 120 * power);
      break;

    case "magnet-range":
      player.stats.magnetRangeBonusCells = Math.min(20, (player.stats.magnetRangeBonusCells || 0) + 5 * power);
      break;

    case "boomerang": {
      player.stats.boomerang = true;
      player.stats.groundPullSpeed = 100;
      player.stats.magnetRangeBonusCells = player.stats.magnetRangeBonusCells || 0;
      break;
    }

    case "boomerang-damage":
      player.stats.boomerangPercent = Math.min(1.5, (player.stats.boomerangPercent || 0) + 0.25 * power);
      break;

    case "boomerang-speed":
      player.stats.groundPullSpeed = Math.min(600, (player.stats.groundPullSpeed || 100) + 100 * power);
      break;

    case "boomerang-range":
      player.stats.magnetRangeBonusCells = Math.min(30, (player.stats.magnetRangeBonusCells || 0) + 5 * power);
      break;

    case "splinter":
      player.stats.splinter = true;
      player.stats.splinterCount = Math.max(1, player.stats.splinterCount || 1);
      player.stats.splinterDamagePercent = Math.max(0.25, player.stats.splinterDamagePercent || 0.25);
      break;

    case "splinter-count":
      player.stats.splinterCount = Math.min(5, (player.stats.splinterCount || 1) + 1 * power);
      break;

    case "splinter-damage":
      player.stats.splinterDamagePercent = Math.min(1.0, (player.stats.splinterDamagePercent || 0.25) + 0.15 * power);
      break;

    case "stun":
      player.stats.stun = true;
      player.stats.stunChance = Math.min(0.45, (player.stats.stunChance || 0) + (power >= 2 ? 0.15 : 0.10));
      player.stats.stunDuration = player.stats.stunDuration || 0.4;
      break;

    case "stun-chance":
      player.stats.stunChance = Math.min(0.45, (player.stats.stunChance || 0.10) + 0.08 * power);
      break;

    case "stun-duration":
      player.stats.stunDuration = Number(Math.min(1.5, (player.stats.stunDuration || 0.4) + 0.3 * power).toFixed(1));
      break;

    case "reactive-armor":
      player.stats.reactiveArmor = true;
      player.stats.reactiveArmorRadius = player.stats.reactiveArmorRadius || 120;
      player.stats.reactiveArmorCooldownBase = player.stats.reactiveArmorCooldownBase || 3.0;
      break;

    case "reactive-armor-radius":
      player.stats.reactiveArmorRadius = Math.min(210, (player.stats.reactiveArmorRadius || 120) + 30 * power);
      break;

    case "reactive-armor-cooldown":
      player.stats.reactiveArmorCooldownBase = Number(Math.max(1.5, (player.stats.reactiveArmorCooldownBase || 3.0) - 0.5 * power).toFixed(1));
      break;

    case "poison":
      player.stats.poison = true;
      player.stats.poisonDamageRatio = Math.max(0.5, player.stats.poisonDamageRatio || 0.5);
      player.stats.poisonDuration = Math.max(2.0, player.stats.poisonDuration || 2.0);
      break;

    case "poison-damage":
      player.stats.poisonDamageRatio = Number(Math.min(5.0, (player.stats.poisonDamageRatio || 0.5) + 0.5 * power).toFixed(2));
      break;

    case "poison-duration":
      player.stats.poisonDuration = Number(Math.min(5.0, (player.stats.poisonDuration || 2.0) + 1.0 * power).toFixed(1));
      break;

    case "parasite":
      player.stats.parasite = true;
      player.stats.parasiteChance = Math.max(0.25, player.stats.parasiteChance || 0.25);
      player.stats.parasiteCount = Math.max(1, player.stats.parasiteCount || 1);
      player.stats.parasiteDamageRatio = Math.max(0.75, player.stats.parasiteDamageRatio || 0.75);
      break;

    case "parasite-chance":
      player.stats.parasiteChance = Math.min(0.50, (player.stats.parasiteChance || 0.25) + 0.05 * power);
      break;

    case "parasite-count":
      player.stats.parasiteCount = Math.min(5, (player.stats.parasiteCount || 1) + 1 * power);
      break;

    case "parasite-damage":
      player.stats.parasiteDamageRatio = Number(Math.min(4.0, (player.stats.parasiteDamageRatio || 0.75) + 0.5 * power).toFixed(2));
      break;

    case "target-mark":
      player.stats.targetMark = true;
      player.stats.markBonus = Math.min(0.80, (player.stats.markBonus || 0) + (power >= 2 ? 0.40 : 0.40));
      player.stats.markDuration = player.stats.markDuration || 4.0;
      break;

    case "mark-amplification":
      player.stats.markBonus = Math.min(0.80, (player.stats.markBonus || 0.40) + 0.15 * power);
      break;

    case "mark-duration":
      player.stats.markDuration = Number(Math.min(10.0, (player.stats.markDuration || 4.0) + 2.0 * power).toFixed(1));
      break;

    case "dash":
      player.stats.dash = true;
      player.stats.dashDistance = Math.max(120, player.stats.dashDistance || 120);
      player.stats.dashCooldownBase = Math.max(2.0, player.stats.dashCooldownBase || 10.0);
      break;

    case "dash-distance":
      player.stats.dashDistance = Math.min(320, (player.stats.dashDistance || 120) + 50 * power);
      break;

    case "dash-cooldown":
      player.stats.dashCooldownBase = Number(Math.max(2.0, (player.stats.dashCooldownBase || 10.0) - 1.5 * power).toFixed(1));
      break;

    case "dash-damage":
      player.stats.dashDamage = true;
      break;

    case "resurrection":
      player.stats.resurrection = true;
      break;

    default:
      return false;
  }

  return true;
}

module.exports = {
  UPGRADE_DEFS,
  findUpgradeDef,
  isUpgradeAvailable,
  applyUpgrade
};
