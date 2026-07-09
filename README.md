# ARIN QR Ordering System — Prototype (v2)

โครงสร้างไฟล์ (5 ไฟล์ ทำงานร่วมกันได้ทันทีในเบราว์เซอร์ ทุกไฟล์ standalone ไม่ต้องมี server):

| ไฟล์ | ใครใช้ | หน้าที่ |
|---|---|---|
| `customer-app.html` | ลูกค้า | สแกน QR → เมนู → ตะกร้า → สั่งอาหาร → ติดตามสถานะเรียลไทม์ |
| `merchant-dashboard.html` | พนักงานรับออเดอร์ (และเจ้าของร้าน) | ดูออเดอร์ active + เปลี่ยนสถานะทีละขั้น เท่านั้น — ไม่เห็นยอดขาย/จัดการร้าน |
| `owner-portal.html` | **เจ้าของร้าน** (role = owner เท่านั้น) | ออเดอร์สด + **ยอดขาย/ชาร์ท** (วัน/สัปดาห์/เดือน/ปี) + จัดการเมนู + ตั้งค่าร้าน + สร้าง/ลบโต๊ะ + **QR โค้ดอัตโนมัติ** |
| `admin-console.html` | **ทีม ARIN (Super Admin)** | เห็นทุกร้านบนแพลตฟอร์ม ยอดขายแยกร้าน/แยกเมนู วัน/สัปดาห์/เดือน/ปี พร้อมชาร์ท |
| `arin-core.js` | (ไฟล์อ้างอิง) | โค้ด data/API layer ตัวเดียวกับที่ inline ไว้ในทั้ง 4 ไฟล์ข้างต้น เก็บไว้อ่าน/แก้ไขง่ายกว่า |

ทุกไฟล์ HTML เป็น **standalone เต็มรูปแบบ** (inline โค้ดหลังบ้านไว้ในตัวเอง) เพื่อไม่ให้เกิดปัญหาหน้าขาวตอนเปิดผ่าน AirDrop/Files บนมือถือหรือไอแพด

## Login สำหรับทดสอบ

| Role | อีเมล | รหัสผ่าน | เข้าไฟล์ไหน |
|---|---|---|---|
| เจ้าของร้าน (ร้าน 1) | demo@arin.co | demo1234 | owner-portal.html หรือ merchant-dashboard.html |
| พนักงาน (ร้าน 1) | staff@arin.co | staff1234 | merchant-dashboard.html เท่านั้น (เข้า owner-portal ไม่ได้) |
| เจ้าของร้าน (ร้าน 2) | manee@arin.co | manee1234 | owner-portal.html หรือ merchant-dashboard.html |
| ARIN Super Admin | admin@arin.co | arinadmin2026 | admin-console.html เท่านั้น |

**การแยกสิทธิ์:** `merchant_users` มีคอลัมน์ `role` (`owner` / `staff`) — พนักงานล็อกอิน owner-portal.html ได้แต่จะถูกเด้งกลับพร้อมข้อความ "หน้านี้สำหรับเจ้าของร้านเท่านั้น" ส่วน Super Admin เป็นคนละระบบ login กับร้านค้าโดยสิ้นเชิง (คนละตาราง คนละ session) เพราะเป็นของทีม ARIN ไม่ใช่ของร้าน

## วิธีทดสอบ

1. เปิด `customer-app.html?restaurant_id=rest_001&table=01` → สั่งอาหาร
2. เปิด `merchant-dashboard.html` (login staff หรือ owner) → เห็นออเดอร์เด้งขึ้นเรียลไทม์ → กดเปลี่ยนสถานะ
3. เปิด `owner-portal.html` (login demo@arin.co) → ดูยอดขายเป็นชาร์ท, ลองเพิ่ม/แก้ไข/ปิดขายเมนู, ลองเพิ่มโต๊ะใหม่แล้วดู QR ที่เจนให้อัตโนมัติ (กด "ดาวน์โหลด QR" ได้เป็นไฟล์ .png พร้อมพิมพ์)
4. เปิด `admin-console.html` (login admin@arin.co) → เลือกดูร้านใดร้านหนึ่งหรือ "รวมทุกร้าน" → สลับช่วงเวลา วัน/สัปดาห์/เดือน/ปี ดูชาร์ทและเมนูขายดี

ข้อมูลตัวอย่างมีย้อนหลัง 60 วันในทั้ง 2 ร้าน (สุ่มยอดขายให้เห็นภาพจริง) ดังนั้นชาร์ทจะมีข้อมูลให้ดูตั้งแต่เปิดครั้งแรก

> ถ้าทดสอบข้ามแท็บ/ข้ามไฟล์แล้วข้อมูลไม่ sync กัน (เช่นสั่งจาก customer-app แล้ว merchant-dashboard ไม่เห็น) มักเป็นเพราะเปิดผ่าน `file://` แล้ว iOS แยก origin ต่อไฟล์ — แนะนำรันผ่าน local server (`python3 -m http.server`) หรือโฮสต์บน GitHub Pages/Netlify เพื่อให้ทุกไฟล์อยู่ origin เดียวกันจริง ๆ

## เอกสารที่ใช้อ้างอิง / ส่วนที่อยู่นอกสโคปเดิม

โค้ดทุกจุดที่ตรงกับ v1.0 spec เดิมมีคอมเมนต์อ้าง AC-x.x / E-หมายเลขกำกับไว้ (ดูรายละเอียดในไฟล์ `arin-core.js`)

**ฟีเจอร์ใหม่ในรอบนี้ (Super Admin, Owner Portal, QR Generator) ไม่ได้อยู่ใน 4 เอกสาร v1.0 เดิมเลย** — ที่จริงเอกสาร API spec เขียนกันไว้ชัดว่า "analytics dashboard" เป็น out-of-scope v1.0 ถูกดองไว้ทำใน v1.3/v2.0+ ดังนั้นควรถือว่านี่คือการเริ่มต้น spec ใหม่ (v1.1/v1.2) ที่ยังไม่มีเอกสารทางการ — ถ้าจะส่งต่อให้ทีมพัฒนาจริงในอนาคต แนะนำให้เขียน PRD/API/DB spec เพิ่มสำหรับ 3 โมดูลนี้เหมือนที่ทำไว้กับระบบสั่งอาหารเดิม โดยมี mapping คร่าว ๆ ไว้ท้ายไฟล์ `arin-core.js` (comment "PRODUCTION MAPPING") ว่าแต่ละฟังก์ชัน mock ควรกลายเป็น endpoint อะไร

## ส่วนที่ยัง "จำลอง" อยู่ (ต้องเปลี่ยนตอนต่อ backend จริง)

| จุดในโค้ด | ตอนนี้ | ตอนต่อ Base44 / Supabase |
|---|---|---|
| `ARIN_DB.*` | อ่าน/เขียน localStorage | `fetch()` ไปที่ endpoint จริง (ดู comment "PRODUCTION MAPPING" ท้าย arin-core.js) |
| `ARIN_REALTIME.*` | BroadcastChannel | Supabase Realtime หรือ WSS ตาม API spec §6 |
| Super Admin auth | คนละ table (`admin_users`) ใน localStorage เดียวกับร้านค้า | ควรแยกเป็นระบบ auth คนละตัวจริง ๆ (เช่น คนละ Supabase project/schema หรือ IAM แยก) เพื่อไม่ให้ข้อมูลรั่วข้ามระบบ |
| merchant password | plaintext เพื่อ demo เท่านั้น | ต้องเป็น `password_hash` (bcrypt/argon2) |
| QR code | เจนด้วย qrcodejs (client-side) ชี้ไปที่ `customer-app.html?restaurant_id=&table=` | เปลี่ยน "URL ฐาน" ในแท็บ "โต๊ะ & QR" เป็นโดเมนจริงตอน deploy แล้ว regenerate ใหม่ (โค้ด QR ไม่เปลี่ยน แค่ URL เปลี่ยน) |

