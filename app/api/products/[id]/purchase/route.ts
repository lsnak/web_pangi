import { NextResponse } from 'next/server';
import { getAsync, runAsync, ensureDBInitialized } from '@/lib/db';
import { getUserIdFromCookies } from '@/lib/jwt';
import { sendDiscordWebhookCustom, createPurchaseEmbed } from '@/lib/discord-webhook';
import { DISCORD_WEBHOOK_URL, base_url } from '@/lib/config';

interface Params { params: { id: string } }

export async function POST(request: Request, { params }: Params) {
  try {
    await ensureDBInitialized();
    
    const userId = getUserIdFromCookies();
    if (!userId) {
      return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
    }

    const productId = Number(params.id);
    if (!Number.isFinite(productId)) {
      return NextResponse.json({ error: '잘못된 제품 ID입니다' }, { status: 400 });
    }

    const body = await request.json();
    const { planDay, amount = 1 } = body;

    if (!planDay) {
      return NextResponse.json({ error: '플랜 기간을 선택해주세요' }, { status: 400 });
    }

    if (!Number.isInteger(amount) || amount <= 0) {
      return NextResponse.json({ error: '올바른 수량을 입력해주세요' }, { status: 400 });
    }

    const product = await getAsync('SELECT * FROM products WHERE id = ?', [productId]);
    if (!product) {
      return NextResponse.json({ error: '제품을 찾을 수 없습니다' }, { status: 404 });
    }

    if (product.status !== '1') {
      return NextResponse.json({ error: '판매 중지된 제품입니다' }, { status: 400 });
    }

    let plans;
    try {
      plans = JSON.parse(product.plan);
    } catch {
      return NextResponse.json({ error: '제품 정보가 올바르지 않습니다' }, { status: 500 });
    }

    const selectedPlan = plans.find((p: any) => p.day === planDay);
    if (!selectedPlan) {
      return NextResponse.json({ error: '선택한 플랜을 찾을 수 없습니다' }, { status: 400 });
    }

    const stock = selectedPlan.stock || [];
    if (stock.length < amount) {
      return NextResponse.json({ 
        error: `재고가 부족합니다 (남은 재고: ${stock.length}개)`,
        availableStock: stock.length
      }, { status: 400 });
    }

    const totalPrice = selectedPlan.price * amount;

    const user = await getAsync('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) {
      return NextResponse.json({ error: '사용자를 찾을 수 없습니다' }, { status: 404 });
    }

    if (user.money < totalPrice) {
      return NextResponse.json({ 
        error: '잔액이 부족합니다',
        required: totalPrice,
        current: user.money,
        shortage: totalPrice - user.money
      }, { status: 400 });
    }

    const purchasedCodes: string[] = [];
    const remainingStock = [...stock];
    
    for (let i = 0; i < amount; i++) {
      const randomIndex = Math.floor(Math.random() * remainingStock.length);
      const code = remainingStock.splice(randomIndex, 1)[0];
      purchasedCodes.push(code);
    }

    const updatedPlans = plans.map((p: any) => {
      if (p.day === planDay) {
        return { ...p, stock: remainingStock };
      }
      return p;
    });

    const newMoney = user.money - totalPrice;
    const newUsedMoney = user.used_money + totalPrice;

    let newRole = user.role;
    if (newUsedMoney >= 500000) {
      newRole = 'VVIP';
    } else if (newUsedMoney >= 300000) {
      newRole = 'VIP';
    } else if (newUsedMoney > 0) {
      newRole = '구매자';
    }

    await runAsync(
      'UPDATE users SET money = ?, used_money = ?, role = ? WHERE id = ?',
      [newMoney, newUsedMoney, newRole, userId]
    );

    await runAsync(
      'UPDATE products SET plan = ? WHERE id = ?',
      [JSON.stringify(updatedPlans), productId]
    );

    for (const code of purchasedCodes) {
      await runAsync(
        'INSERT INTO buylogs (user_id, product_id, product_name, plan_day, amount, price, code) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [userId, productId, product.name, planDay, 1, selectedPlan.price, code]
      );
    }

    let roleMessage = '';
    if (user.role !== newRole) {
      roleMessage = ` 축하합니다! ${newRole} 등급으로 승급되었습니다! 🎉`;
    }

    const webhookUrl = DISCORD_WEBHOOK_URL;
    if (webhookUrl) {
      const productImageUrl = `${base_url}/products/${productId}.png`;
      
      const webhookPayload = createPurchaseEmbed(
        userId,
        user.name || userId,
        product.name,
        planDay,
        selectedPlan.price,
        amount,
        productImageUrl
      );

      sendDiscordWebhookCustom(webhookUrl, webhookPayload).catch(error => {
        console.error('Discord webhook 전송 실패:', error);
      });
    }

    return NextResponse.json({ 
      success: true,
      message: `구매가 완료되었습니다.${roleMessage}`,
      data: {
        productId,
        productName: product.name,
        planDay,
        amount,
        totalPrice,
        code: purchasedCodes.join(', '),
        codes: purchasedCodes,
        remainingMoney: newMoney,
        remainingStock: remainingStock.length,
        userRole: newRole,
        totalSpent: newUsedMoney,
        roleChanged: user.role !== newRole
      }
    });

  } catch (error) {
    console.error('구매 처리 오류:', error);
    return NextResponse.json({ 
      error: '구매 처리 중 오류가 발생했습니다' 
    }, { status: 500 });
  }
}

