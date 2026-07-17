/**
 * ARIN QR ORDERING SYSTEM — CORE DATA / API LAYER (v3 — SUPABASE)
 * =====================================================================
 * Doc refs: ARIN-API-QR-001 v1.0, ARIN-DB-QR-001 v1.0, ARIN-EDGE-QR-001 v1.0, ARIN-AC-QR-001 v1.0
 *
 * เปลี่ยนจาก v2 (localStorage mock) มาเป็นเชื่อมต่อ Supabase จริงทั้งหมด
 * ทุกฟังก์ชันใน ARIN_DB ยังคงคืนค่า envelope เดิม { success, data } / { success, error }
 * แต่ตอนนี้เป็น ASYNC (Promise) เพราะเรียกเครือข่ายจริง — ดู "BREAKING CHANGE" ท้ายไฟล์
 *
 * ตารางที่ยืนยันว่ามีจริงใน Supabase (ตามที่ Nam ให้มา):
 *   - restaurants
 *   - restaurant_tables
 *   - menu_items
 *   - orders            (คอลัมน์ items เป็น jsonb แทนตาราง order_items เดิม — ดูหมายเหตุด้านล่าง)
 *
 * ตารางที่ "สมมติ" ว่ามี (ของเดิมมีแต่ไม่ได้อยู่ใน 4 ตารางที่ระบุ) — ถ้ายังไม่มี ดู SQL
 * ตัวอย่างท้ายไฟล์:
 *   - merchant_users    (id, restaurant_id, email, password, role, is_locked, created_at, last_login_at)
 *   - admin_users       (id, email, password, name, created_at)
 *
 * ⚠️ ความปลอดภัย: ฟังก์ชัน merchantLogin/adminLogin ยังคงเทียบรหัสผ่านแบบ plaintext
 * ผ่าน anon key จากฝั่ง client เหมือนของเดิม เพื่อไม่ให้พฤติกรรมระบบเปลี่ยน — แต่ตรงนี้
 * "ไม่ปลอดภัยสำหรับ production จริง" ถ้าไม่ตั้ง Row Level Security (RLS) ปิดการ SELECT
 * คอลัมน์ password จาก client โดยตรง แนะนำให้ย้ายไปใช้ Supabase Auth หรือ RPC
 * (Postgres function แบบ SECURITY DEFINER) ในเฟสถัดไป
 */

(function (global) {
  'use strict';

  // ---------------------------------------------------------------------
  // 0. SUPABASE CONFIG — ใส่ค่าของโปรเจกต์ตัวเองตรงนี้
  // ---------------------------------------------------------------------
  const SUPABASE_URL = 'https://mdekgqaipcxeopptfms.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_AgMPYdm9XKIMLd3qPt9XyQ_rX-ttYYz';

  // ต้องโหลด Supabase JS SDK มาก่อนไฟล์นี้ เช่น:
  // <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  if (!global.supabase || typeof global.supabase.createClient !== 'function') {
    console.error('[ARIN] ไม่พบ Supabase SDK — กรุณาใส่ <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script> ก่อนไฟล์ arin-core.js');
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn('[ARIN] ยังไม่ได้ใส่ SUPABASE_URL / SUPABASE_ANON_KEY ที่ด้านบนของ arin-core.js');
  }

  const sb = global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ---------------------------------------------------------------------
  // 1. LOCAL-ONLY KEYS — เหลือแค่ auth session/token ที่เหมาะจะเก็บฝั่ง client
  //    (ไม่ใช่ "ข้อมูลระบบ" จึงไม่ย้ายไป Supabase table)
  // ---------------------------------------------------------------------
  const KEYS = {
    session: 'arin_qr_merchant_session',
    adminSession: 'arin_qr_admin_session',
  };

  function readLocal(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch (e) { return fallback; }
  }
  function writeLocal(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
  function uid(prefix) { return (prefix ? prefix + '_' : '') + Math.random().toString(36).slice(2, 10); }
  function nowIso() { return new Date().toISOString(); } // always UTC (E26) — format locally on display only
  function envelopeOk(data) { return { success: true, data, meta: { timestamp: nowIso() } }; }
  function envelopeErr(code, message) { return { success: false, error: { code, message }, meta: { timestamp: nowIso() } }; }

  // Helper: แปลง error จาก Supabase ให้เข้ากับ envelope เดิม
  function supabaseErr(error) {
    return envelopeErr(error.code || 'SUPABASE_ERROR', error.message || 'เชื่อมต่อฐานข้อมูลไม่สำเร็จ');
  }

  // ---------------------------------------------------------------------
  // 2. REALTIME LAYER — Supabase Realtime แทน BroadcastChannel เดิม
  //    ดักฟัง postgres_changes บนตาราง orders แบบ INSERT/UPDATE จริง
  //    หมายเหตุ: ต้องเปิด Realtime replication ให้ตาราง orders ใน Supabase
  //    Dashboard > Database > Replication ก่อน ไม่งั้นจะไม่มี event ยิงมา
  // ---------------------------------------------------------------------
  const ARIN_REALTIME = {
    _channels: {},

    // ฟังทุกออเดอร์ (ใหม่ + อัปเดตสถานะ) ของร้านนี้ — ใช้ในหน้า iPad merchant dashboard
    subscribeMerchant(restaurantId, cb) {
      const channelName = `arin-orders-restaurant-${restaurantId}`;
      const channel = sb
        .channel(channelName)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'orders', filter: `restaurant_id=eq.${restaurantId}` },
          (payload) => cb({ event: 'order.created', data: payload.new })
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'orders', filter: `restaurant_id=eq.${restaurantId}` },
          (payload) => cb({ event: 'order.updated', data: payload.new })
        )
        .subscribe();

      this._channels[channelName] = channel;
      return () => { sb.removeChannel(channel); delete this._channels[channelName]; };
    },

    // ฟังออเดอร์เดียว (เช่น หน้าลูกค้าเช็คสถานะออเดอร์ตัวเอง real-time)
    subscribeOrder(orderId, cb) {
      const channelName = `arin-order-${orderId}`;
      const channel = sb
        .channel(channelName)
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'orders', filter: `id=eq.${orderId}` },
          (payload) => cb({ event: 'order.updated', data: payload.new })
        )
        .subscribe();

      this._channels[channelName] = channel;
      return () => { sb.removeChannel(channel); delete this._channels[channelName]; };
    },

    // เลิกฟังทั้งหมด (เรียกตอนออกจากหน้า/logout)
    unsubscribeAll() {
      Object.values(this._channels).forEach((ch) => sb.removeChannel(ch));
      this._channels = {};
    },
  };

  // ---------------------------------------------------------------------
  // 3. DATE BUCKETING HELPERS (สำหรับ Super Admin analytics — pure JS ไม่เกี่ยวกับ storage)
  // ---------------------------------------------------------------------
  const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function startOfWeek(d) { const x = startOfDay(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); return x; } // Monday start
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function startOfYear(d) { return new Date(d.getFullYear(), 0, 1); }
  function stepDate(d, period, delta) {
    const x = new Date(d);
    if (period === 'day') x.setDate(x.getDate() + delta);
    else if (period === 'week') x.setDate(x.getDate() + delta * 7);
    else if (period === 'month') x.setMonth(x.getMonth() + delta);
    else if (period === 'year') x.setFullYear(x.getFullYear() + delta);
    return x;
  }
  function bucketConfig(period) {
    const table = {
      day: { count: 14, startFn: startOfDay, label: (d) => `${d.getDate()}/${d.getMonth() + 1}` },
      week: { count: 10, startFn: startOfWeek, label: (d) => `${d.getDate()}/${d.getMonth() + 1}` },
      month: { count: 12, startFn: startOfMonth, label: (d) => `${THAI_MONTHS[d.getMonth()]} ${d.getFullYear()}` },
      year: { count: 5, startFn: startOfYear, label: (d) => `${d.getFullYear()}` },
    };
    return table[period] || table.day;
  }
  function buildBuckets(period) {
    const cfg = bucketConfig(period);
    const now = new Date();
    const currentStart = cfg.startFn(now);
    const starts = [];
    for (let i = cfg.count - 1; i >= 0; i--) starts.push(stepDate(currentStart, period, -i));
    return starts.map((start, i) => ({
      start,
      end: i + 1 < starts.length ? starts[i + 1] : stepDate(start, period, 1),
      label: cfg.label(start),
    }));
  }

  // ---------------------------------------------------------------------
  // 4. API FUNCTIONS — ทุกฟังก์ชันเป็น async ตอนนี้
  // ---------------------------------------------------------------------
  const STATUS_ORDER = ['pending', 'accepted', 'preparing', 'ready', 'completed'];

  // orders.items เก็บเป็น jsonb array ตรงๆ ใน row เดียว จึงไม่ต้อง join ตารางแยกอีก
  function hydrateOrder(order) {
    return { ...order, order_id: order.id, items: order.items || [] };
  }

  const ARIN_DB = {
    // =====================================================================
    // CUSTOMER-FACING
    // =====================================================================
    async getRestaurantMenu(restaurantId, tableNumber) {
      const { data: restaurant, error: rErr } = await sb.from('restaurants').select('*').eq('id', restaurantId).maybeSingle();
      if (rErr) return supabaseErr(rErr);
      if (!restaurant) return envelopeErr('RESTAURANT_NOT_FOUND', 'ไม่พบร้านนี้ในระบบ');
      if (!restaurant.is_active) return envelopeErr('RESTAURANT_INACTIVE', 'ร้านปิดรับออเดอร์ชั่วคราว');

      const { data: table, error: tErr } = await sb
        .from('restaurant_tables')
        .select('*')
        .eq('restaurant_id', restaurantId)
        .eq('table_number', tableNumber)
        .maybeSingle();
      if (tErr) return supabaseErr(tErr);
      if (!table) return envelopeErr('TABLE_NOT_FOUND', 'ไม่พบโต๊ะนี้ กรุณาแจ้งพนักงาน');

      const { data: menu, error: mErr } = await sb.from('menu_items').select('*').eq('restaurant_id', restaurantId);
      if (mErr) return supabaseErr(mErr);

      return envelopeOk({
        restaurant: { id: restaurant.id, name: restaurant.name, logo: restaurant.logo_url },
        table: { id: table.id, table_number: table.table_number },
        menu,
      });
    },

    async createOrder({ restaurant_id, table_id, items, idempotency_key }) {
      const { data: restaurant, error: rErr } = await sb.from('restaurants').select('*').eq('id', restaurant_id).maybeSingle();
      if (rErr) return supabaseErr(rErr);
      if (!restaurant || !restaurant.is_active) return envelopeErr('RESTAURANT_INACTIVE', 'ร้านปิดรับออเดอร์');

      const { data: table, error: tErr } = await sb.from('restaurant_tables').select('*').eq('id', table_id).maybeSingle();
      if (tErr) return supabaseErr(tErr);
      if (!table) return envelopeErr('TABLE_NOT_FOUND', 'table_id ไม่ถูกต้อง');

      if (!items || items.length === 0) return envelopeErr('EMPTY_ORDER', 'ตะกร้าว่าง');

      // idempotency: กันยิงซ้ำ (เช่น กดสั่งซ้ำเพราะเน็ตหน่วง)
      if (idempotency_key) {
        const { data: dupe, error: dErr } = await sb.from('orders').select('*').eq('idempotency_key', idempotency_key).maybeSingle();
        if (dErr) return supabaseErr(dErr);
        if (dupe) return envelopeOk(hydrateOrder(dupe));
      }

      // ราคาต้องอ่านจาก DB เสมอ ห้ามเชื่อราคาที่ client ส่งมา
      const { data: menuItems, error: menuErr } = await sb.from('menu_items').select('*').eq('restaurant_id', restaurant_id);
      if (menuErr) return supabaseErr(menuErr);

      let total = 0;
      const resolvedItems = [];
      for (const it of items) {
        if (!Number.isInteger(it.quantity) || it.quantity <= 0) return envelopeErr('INVALID_QUANTITY', 'จำนวนต้องมากกว่า 0');
        const menuItem = menuItems.find((m) => m.id === it.menu_id);
        if (!menuItem || !menuItem.available) return envelopeErr('MENU_ITEM_UNAVAILABLE', `"${menuItem ? menuItem.name : it.menu_id}" เพิ่งหมด`);
        total += menuItem.price * it.quantity;
        resolvedItems.push({
          id: uid('oi'),
          menu_item_id: menuItem.id,
          menu_item_name: menuItem.name,
          unit_price: menuItem.price,
          quantity: it.quantity,
          note: (it.note || '').slice(0, 200),
        });
      }

      const { data: inserted, error: insErr } = await sb
        .from('orders')
        .insert({
          restaurant_id,
          table_id,
          status: 'pending',
          total,
          items: resolvedItems,
          idempotency_key: idempotency_key || uid('idem'),
        })
        .select()
        .single();
      if (insErr) return supabaseErr(insErr);

      // ไม่ต้อง _emit เองแล้ว — Supabase Realtime จะยิง postgres_changes INSERT
      // ไปหาทุก client ที่ subscribeMerchant ไว้โดยอัตโนมัติ
      return envelopeOk(hydrateOrder(inserted));
    },

    async getOrder(orderId) {
      const { data: order, error } = await sb.from('orders').select('*').eq('id', orderId).maybeSingle();
      if (error) return supabaseErr(error);
      if (!order) return envelopeErr('ORDER_NOT_FOUND', 'ไม่พบออเดอร์นี้');
      return envelopeOk(hydrateOrder(order));
    },

    // =====================================================================
    // MERCHANT AUTH
    // ⚠️ สมมติว่ามีตาราง merchant_users ใน Supabase (ดู SQL ท้ายไฟล์ถ้ายังไม่มี)
    // session/token ยังเก็บใน localStorage ฝั่ง client เหมือนเดิม (ไม่ใช่ business data)
    // =====================================================================
    async merchantLogin(email, password) {
      const { data: user, error } = await sb.from('merchant_users').select('*').eq('email', email).maybeSingle();
      if (error) return supabaseErr(error);
      if (!user || user.password !== password) return envelopeErr('INVALID_CREDENTIALS', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
      if (user.is_locked) return envelopeErr('ACCOUNT_LOCKED', 'บัญชีถูกล็อก');

      await sb.from('merchant_users').update({ last_login_at: nowIso() }).eq('id', user.id);

      const session = {
        access_token: uid('access'),
        refresh_token: uid('refresh'),
        restaurant_id: user.restaurant_id,
        email: user.email,
        role: user.role || 'staff',
        issued_at: Date.now(),
        expires_in: 3600,
      };
      writeLocal(KEYS.session, session);
      return envelopeOk({ ...session });
    },
    // หมายเหตุ: refresh/expire จริงต้องทำผ่าน server-side (Edge Function) เพราะ client
    // ฝั่งนี้ไม่มีทางตรวจสอบ token ปลอมได้ — ฟังก์ชันนี้ยังเป็น mock local เหมือนเดิม
    async refreshToken(refresh_token) {
      const session = readLocal(KEYS.session, null);
      if (!session || session.refresh_token !== refresh_token) return envelopeErr('REFRESH_TOKEN_EXPIRED', 'กรุณาเข้าสู่ระบบใหม่');
      session.access_token = uid('access');
      session.issued_at = Date.now();
      writeLocal(KEYS.session, session);
      return envelopeOk({ access_token: session.access_token, expires_in: 3600 });
    },
    logout() {
      ARIN_REALTIME.unsubscribeAll();
      localStorage.removeItem(KEYS.session);
    },
    getSession() { return readLocal(KEYS.session, null); },

    // =====================================================================
    // MERCHANT ORDER CONSOLE (staff + owner)
    // =====================================================================
    async listMerchantOrders(restaurantId) {
      const active = STATUS_ORDER.filter((s) => s !== 'completed');
      // ใช้ embed resource ของ Supabase (ต้องมี FK: orders.table_id -> restaurant_tables.id)
      // ถ้าชื่อ relationship ฝั่ง Supabase ไม่ตรง ให้แก้ 'restaurant_tables' ตรงนี้ตามจริง
      const { data: orders, error } = await sb
        .from('orders')
        .select('*, restaurant_tables(table_number)')
        .eq('restaurant_id', restaurantId)
        .in('status', active)
        .order('created_at', { ascending: true });
      if (error) return supabaseErr(error);

      return envelopeOk({
        orders: orders.map((o) => ({
          order_id: o.id,
          table_number: o.restaurant_tables ? o.restaurant_tables.table_number : '?',
          status: o.status,
          total: o.total,
          item_count: (o.items || []).reduce((n, i) => n + i.quantity, 0),
          created_at: o.created_at,
        })),
      });
    },

    async getMerchantOrderDetail(orderId, restaurantId) {
      const { data: order, error } = await sb.from('orders').select('*').eq('id', orderId).maybeSingle();
      if (error) return supabaseErr(error);
      if (!order) return envelopeErr('ORDER_NOT_FOUND', 'ไม่พบออเดอร์');
      if (order.restaurant_id !== restaurantId) return envelopeErr('FORBIDDEN', 'ออเดอร์นี้ไม่ใช่ของร้านนี้');
      return envelopeOk(hydrateOrder(order));
    },

    async updateOrderStatus(orderId, restaurantId, newStatus) {
      const { data: order, error: fErr } = await sb.from('orders').select('*').eq('id', orderId).maybeSingle();
      if (fErr) return supabaseErr(fErr);
      if (!order) return envelopeErr('ORDER_NOT_FOUND', 'ไม่พบออเดอร์');
      if (order.restaurant_id !== restaurantId) return envelopeErr('FORBIDDEN', 'ไม่มีสิทธิ์แก้ไขออเดอร์นี้');

      const currentIdx = STATUS_ORDER.indexOf(order.status);
      const nextIdx = STATUS_ORDER.indexOf(newStatus);
      if (nextIdx !== currentIdx + 1) return envelopeErr('INVALID_STATUS_TRANSITION', 'ไม่สามารถข้ามสถานะได้');

      const { data: updated, error: uErr } = await sb
        .from('orders')
        .update({ status: newStatus, updated_at: nowIso() })
        .eq('id', orderId)
        .select()
        .single();
      if (uErr) return supabaseErr(uErr);

      // Supabase Realtime ยิง postgres_changes UPDATE ไปหา subscriber เองอัตโนมัติ
      return envelopeOk(hydrateOrder(updated));
    },

    // =====================================================================
    // OWNER-ONLY RESTAURANT SELF-SERVICE MANAGEMENT
    // ทุกฟังก์ชันเช็ค restaurant_id ownership เหมือนเดิม (AC-6.3 FORBIDDEN pattern)
    // =====================================================================
    async updateRestaurantProfile(restaurantId, patch) {
      const { data: updated, error } = await sb
        .from('restaurants')
        .update({ ...patch, updated_at: nowIso() })
        .eq('id', restaurantId)
        .select()
        .maybeSingle();
      if (error) return supabaseErr(error);
      if (!updated) return envelopeErr('RESTAURANT_NOT_FOUND', 'ไม่พบร้าน');
      return envelopeOk(updated);
    },

    async listMenuItemsForOwner(restaurantId) {
      const { data: menu, error } = await sb
        .from('menu_items')
        .select('*')
        .eq('restaurant_id', restaurantId)
        .order('category', { ascending: true });
      if (error) return supabaseErr(error);
      return envelopeOk({ menu });
    },

    async createMenuItem(restaurantId, item) {
      if (!item.name || item.name.trim() === '') return envelopeErr('VALIDATION_ERROR', 'กรุณาใส่ชื่อเมนู');
      if (typeof item.price !== 'number' || item.price < 0) return envelopeErr('VALIDATION_ERROR', 'ราคาต้องไม่ติดลบ');

      const { data: newItem, error } = await sb
        .from('menu_items')
        .insert({
          restaurant_id: restaurantId,
          name: item.name.trim(),
          description: item.description || '',
          price: item.price,
          category: item.category || 'เมนู',
          image_url: item.image_url || '',
          available: item.available !== false,
        })
        .select()
        .single();
      if (error) return supabaseErr(error);
      return envelopeOk(newItem);
    },

    async updateMenuItem(menuItemId, restaurantId, patch) {
      const { data: item, error: fErr } = await sb.from('menu_items').select('*').eq('id', menuItemId).maybeSingle();
      if (fErr) return supabaseErr(fErr);
      if (!item) return envelopeErr('MENU_ITEM_NOT_FOUND', 'ไม่พบเมนูนี้');
      if (item.restaurant_id !== restaurantId) return envelopeErr('FORBIDDEN', 'ไม่มีสิทธิ์แก้ไขเมนูนี้');
      if (patch.price !== undefined && (typeof patch.price !== 'number' || patch.price < 0)) return envelopeErr('VALIDATION_ERROR', 'ราคาต้องไม่ติดลบ');

      const { data: updated, error: uErr } = await sb
        .from('menu_items')
        .update({ ...patch, updated_at: nowIso() })
        .eq('id', menuItemId)
        .select()
        .single();
      if (uErr) return supabaseErr(uErr);
      return envelopeOk(updated);
    },

    async deleteMenuItem(menuItemId, restaurantId) {
      const { data: item, error: fErr } = await sb.from('menu_items').select('*').eq('id', menuItemId).maybeSingle();
      if (fErr) return supabaseErr(fErr);
      if (!item) return envelopeErr('MENU_ITEM_NOT_FOUND', 'ไม่พบเมนูนี้');
      if (item.restaurant_id !== restaurantId) return envelopeErr('FORBIDDEN', 'ไม่มีสิทธิ์ลบเมนูนี้');

      // Mirrors DB spec §7: เมนูที่เคยถูกสั่งแล้วห้ามลบจริง (มีอยู่ใน orders.items jsonb ของร้านนี้)
      // ไม่มีตาราง order_items แยกแล้ว จึงต้องเช็คจาก orders.items แทน
      const { data: orders, error: oErr } = await sb.from('orders').select('items').eq('restaurant_id', restaurantId);
      if (oErr) return supabaseErr(oErr);
      const referenced = orders.some((o) => (o.items || []).some((oi) => oi.menu_item_id === menuItemId));
      if (referenced) return envelopeErr('MENU_ITEM_IN_USE', 'เมนูนี้เคยถูกสั่งแล้ว ลบไม่ได้ — ปิดการขายแทนได้');

      const { error: dErr } = await sb.from('menu_items').delete().eq('id', menuItemId);
      if (dErr) return supabaseErr(dErr);
      return envelopeOk({ deleted: true });
    },

    async listTables(restaurantId) {
      const { data: tables, error } = await sb.from('restaurant_tables').select('*').eq('restaurant_id', restaurantId);
      if (error) return supabaseErr(error);
      tables.sort((a, b) => a.table_number.localeCompare(b.table_number, 'th', { numeric: true }));
      return envelopeOk({ tables });
    },

    async createTable(restaurantId, tableNumber) {
      const num = String(tableNumber).trim();
      if (!num) return envelopeErr('VALIDATION_ERROR', 'กรุณาใส่หมายเลขโต๊ะ');

      // Mirrors DB spec §3: UNIQUE (restaurant_id, table_number)
      const { data: existing, error: eErr } = await sb
        .from('restaurant_tables')
        .select('id')
        .eq('restaurant_id', restaurantId)
        .eq('table_number', num)
        .maybeSingle();
      if (eErr) return supabaseErr(eErr);
      if (existing) return envelopeErr('TABLE_NUMBER_TAKEN', `โต๊ะ ${num} มีอยู่แล้ว`);

      const { data: table, error } = await sb
        .from('restaurant_tables')
        .insert({ restaurant_id: restaurantId, table_number: num, qr_code_url: '' })
        .select()
        .single();
      if (error) return supabaseErr(error);
      return envelopeOk(table);
    },

    async deleteTable(tableId, restaurantId) {
      const { data: table, error: fErr } = await sb.from('restaurant_tables').select('*').eq('id', tableId).maybeSingle();
      if (fErr) return supabaseErr(fErr);
      if (!table) return envelopeErr('TABLE_NOT_FOUND', 'ไม่พบโต๊ะนี้');
      if (table.restaurant_id !== restaurantId) return envelopeErr('FORBIDDEN', 'ไม่มีสิทธิ์ลบโต๊ะนี้');

      const { data: activeOrders, error: oErr } = await sb
        .from('orders')
        .select('id')
        .eq('table_id', tableId)
        .neq('status', 'completed')
        .limit(1);
      if (oErr) return supabaseErr(oErr);
      if (activeOrders && activeOrders.length > 0) return envelopeErr('TABLE_HAS_ACTIVE_ORDER', 'โต๊ะนี้มีออเดอร์ค้างอยู่ ลบไม่ได้ตอนนี้');

      const { error: dErr } = await sb.from('restaurant_tables').delete().eq('id', tableId);
      if (dErr) return supabaseErr(dErr);
      return envelopeOk({ deleted: true });
    },

    // Builds the URL a printed QR code should point to. `baseUrl` lets the
    // owner point it at wherever customer-app.html is actually hosted.
    // (pure function — ไม่แตะฐานข้อมูล จึงยังเป็น sync ได้ตามเดิม)
    buildCustomerLink(baseUrl, restaurantId, tableNumber) {
      const base = (baseUrl || 'customer-app.html').replace(/\/$/, '');
      return `${base}?restaurant_id=${encodeURIComponent(restaurantId)}&table=${encodeURIComponent(tableNumber)}`;
    },

    // =====================================================================
    // SUPER ADMIN (platform level, แยก auth จาก merchant_users คนละ realm)
    // ⚠️ สมมติว่ามีตาราง admin_users ใน Supabase (ดู SQL ท้ายไฟล์ถ้ายังไม่มี)
    // =====================================================================
    async adminLogin(email, password) {
      const { data: admin, error } = await sb.from('admin_users').select('*').eq('email', email).maybeSingle();
      if (error) return supabaseErr(error);
      if (!admin || admin.password !== password) return envelopeErr('INVALID_CREDENTIALS', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');

      const session = { access_token: uid('admin_access'), name: admin.name, email: admin.email, issued_at: Date.now() };
      writeLocal(KEYS.adminSession, session);
      return envelopeOk(session);
    },
    adminLogout() {
      ARIN_REALTIME.unsubscribeAll();
      localStorage.removeItem(KEYS.adminSession);
    },
    getAdminSession() { return readLocal(KEYS.adminSession, null); },

    async adminListRestaurants() {
      const { data: restaurants, error: rErr } = await sb.from('restaurants').select('*');
      if (rErr) return supabaseErr(rErr);

      const { data: orders, error: oErr } = await sb.from('orders').select('restaurant_id, total, created_at');
      if (oErr) return supabaseErr(oErr);

      const todayStart = startOfDay(new Date());
      return envelopeOk({
        restaurants: restaurants.map((r) => {
          const rOrders = orders.filter((o) => o.restaurant_id === r.id);
          const todayOrders = rOrders.filter((o) => new Date(o.created_at) >= todayStart);
          return {
            id: r.id,
            name: r.name,
            is_active: r.is_active,
            total_orders: rOrders.length,
            total_revenue: rOrders.reduce((s, o) => s + o.total, 0),
            today_orders: todayOrders.length,
            today_revenue: todayOrders.reduce((s, o) => s + o.total, 0),
          };
        }),
      });
      // หมายเหตุสเกล: ถ้าจำนวนออเดอร์เยอะมากในอนาคต ควรย้าย aggregation นี้ไปเป็น
      // Postgres VIEW หรือ RPC function แทนการดึงทุกแถวมาคำนวณฝั่ง client
    },

    // เพิ่มร้านค้าใหม่ (Super Admin) แล้วสร้างโต๊ะหมายเลข 1 ผูกให้อัตโนมัติ
    async addRestaurant(name, ownerName, phone) {
      const { data: restaurant, error: resError } = await sb
        .from('restaurants')
        .insert([{ name, owner_name: ownerName, phone }])
        .select()
        .single();
      if (resError) return supabaseErr(resError);

      const { error: tableError } = await sb
        .from('restaurant_tables')
        .insert([{ restaurant_id: restaurant.id, table_number: 1 }]);
      if (tableError) return supabaseErr(tableError);

      return envelopeOk(restaurant);
    },

    // restaurantId = null หมายถึง "รวมทุกร้าน"
    async adminGetSalesSeries(restaurantId, period) {
      const buckets = buildBuckets(period);
      let query = sb.from('orders').select('restaurant_id, total, created_at').gte('created_at', buckets[0].start.toISOString());
      if (restaurantId) query = query.eq('restaurant_id', restaurantId);
      const { data: orders, error } = await query;
      if (error) return supabaseErr(error);

      const series = buckets.map((b) => {
        const inBucket = orders.filter((o) => { const t = new Date(o.created_at); return t >= b.start && t < b.end; });
        return { label: b.label, revenue: inBucket.reduce((s, o) => s + o.total, 0), orders: inBucket.length };
      });
      return envelopeOk({ period, series });
    },

    async adminGetMenuBreakdown(restaurantId, period) {
      const buckets = buildBuckets(period);
      const rangeStart = buckets[0].start;

      let query = sb.from('orders').select('restaurant_id, items, created_at').gte('created_at', rangeStart.toISOString());
      if (restaurantId) query = query.eq('restaurant_id', restaurantId);
      const { data: orders, error } = await query;
      if (error) return supabaseErr(error);

      const byName = {};
      orders.forEach((o) => {
        (o.items || []).forEach((it) => {
          byName[it.menu_item_name] = byName[it.menu_item_name] || { name: it.menu_item_name, quantity: 0, revenue: 0 };
          byName[it.menu_item_name].quantity += it.quantity;
          byName[it.menu_item_name].revenue += it.quantity * it.unit_price;
        });
      });
      const breakdown = Object.values(byName).sort((a, b) => b.revenue - a.revenue);
      return envelopeOk({ period, breakdown });
    },
  };

  // ---------------------------------------------------------------------
  // 5. EXPORT
  // ---------------------------------------------------------------------
  global.ARIN_DB = ARIN_DB;
  global.ARIN_REALTIME = ARIN_REALTIME;
  global.ARIN_UTIL = { uid, nowIso, STATUS_ORDER };
})(window);

/*
 * ⚠️⚠️ BREAKING CHANGE — โปรดอ่านก่อนต่อกับ UI เดิม ⚠️⚠️
 * ----------------------------------------------------------------------
 * ทุกฟังก์ชันใน ARIN_DB (ยกเว้น buildCustomerLink, getSession, getAdminSession,
 * logout, adminLogout) ตอนนี้เป็น ASYNC — คืนค่าเป็น Promise ไม่ใช่ค่าตรงๆ อีกต่อไป
 *
 * โค้ดเดิมแบบนี้จะพัง:
 *     const res = ARIN_DB.getRestaurantMenu(id, table);   // res คือ Promise ไม่ใช่ envelope
 *
 * ต้องแก้เป็น:
 *     const res = await ARIN_DB.getRestaurantMenu(id, table);
 *   หรือ
 *     ARIN_DB.getRestaurantMenu(id, table).then((res) => { ... });
 *
 * ไฟล์ที่น่าจะต้องไล่แก้: customer-app.html, merchant-dashboard.html,
 * super-admin-console.html, restaurant-owner-portal.html
 *
 *
 * SQL สำหรับสร้างตาราง merchant_users / admin_users ถ้ายังไม่มีใน Supabase:
 * ----------------------------------------------------------------------
 * create table merchant_users (
 *   id uuid primary key default gen_random_uuid(),
 *   restaurant_id uuid references restaurants(id) on delete cascade,
 *   email text unique not null,
 *   password text not null,
 *   role text not null default 'staff' check (role in ('owner', 'staff')),
 *   is_locked boolean not null default false,
 *   created_at timestamptz not null default now(),
 *   last_login_at timestamptz
 * );
 *
 * create table admin_users (
 *   id uuid primary key default gen_random_uuid(),
 *   email text unique not null,
 *   password text not null,
 *   name text,
 *   created_at timestamptz not null default now()
 * );
 *
 *
 * เช็คลิสต์ฝั่ง Supabase ก่อนใช้งานจริง:
 * ----------------------------------------------------------------------
 * 1. เปิด Row Level Security (RLS) ทุกตาราง แล้วตั้ง policy ให้เหมาะสม —
 *    ตอนนี้ query ทั้งหมดยิงด้วย anon key จาก client ถ้าไม่ตั้ง RLS
 *    ใครก็ได้ที่รู้ URL project จะอ่าน/แก้ข้อมูลทุกร้านได้หมด
 * 2. Database > Replication: เปิด Realtime ให้ตาราง `orders` (และ `menu_items`
 *    ถ้าอยากให้เมนูหมด/มาใหม่อัปเดตสดด้วย)
 * 3. ตรวจว่า orders.table_id มี Foreign Key ชี้ไปที่ restaurant_tables.id จริง
 *    ไม่งั้น embed query ใน listMerchantOrders() จะ error
 * 4. พิจารณาย้าย merchantLogin/adminLogin ไปใช้ Supabase Auth หรือ RPC function
 *    ในเฟสถัดไป เพื่อไม่ให้เทียบรหัสผ่าน plaintext ตรงๆ จาก client
 */
