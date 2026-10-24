# License Key API (Vercel + Firebase Firestore)

API cấp & kiểm tra key bản quyền:

- **Gói**: `basic`, `premium`
- **Thời hạn**: `hour` (giờ), `day` (ngày), `week` (tuần), `month` (tháng = 30 ngày), `year` (năm = 365 ngày), `lifetime` (vĩnh viễn). Có thể nhân số lượng, ví dụ `3 day`, `6 month`.
- **Khoá thiết bị (HWID)**: mỗi key giới hạn 1, 2, 3… thiết bị (`maxDevices`, tối đa 100). Có thể tắt khoá (`deviceLock:false`).
- **Tạo hàng loạt**: tối đa 1000 key / lần gọi, gọi lại bao nhiêu lần tuỳ ý.
- **Thời hạn tính từ lần dùng đầu tiên** (không phải lúc tạo key).
- Có admin panel (`/`) để tạo / khoá / gia hạn / xoá key.

```
api/verify.js            POST /api/verify          (client gọi)
api/admin/[action].js    POST /api/admin/<action>  (admin)
public/index.html        Admin panel
lib/                     logic dùng chung
firestore.rules          chặn truy cập trực tiếp vào DB
test/smoke.test.js       npm test (Firestore giả lập)
```

## 1. Cài đặt Firebase

1. [Firebase Console](https://console.firebase.google.com) → tạo project → **Build → Firestore Database → Create database** (production mode).
2. **Project settings → Service accounts → Generate new private key** → tải file JSON.
3. (Khuyến nghị) Dán `firestore.rules` vào tab **Rules** của Firestore để không ai đọc/ghi trực tiếp được. Server dùng service account nên vẫn hoạt động bình thường.

> Bạn **không cần** đưa email/mật khẩu Firebase cho bất kỳ ai hay đưa vào code. Chỉ dùng file service account ở bước 2, đặt trong biến môi trường của Vercel. **Không commit file JSON đó lên GitHub.**

## 2. Deploy lên Vercel

```bash
npm i -g vercel
vercel          # lần đầu: link project
vercel --prod
```

Hoặc đẩy code lên GitHub rồi **Import** trong Vercel (Framework: *Other*, không cần build command).

Vào **Project → Settings → Environment Variables**, thêm:

| Biến | Giá trị |
|---|---|
| `ADMIN_SECRET` | chuỗi ngẫu nhiên ≥ 16 ký tự (mật khẩu admin) |
| `FIREBASE_SERVICE_ACCOUNT` | dán nguyên nội dung file JSON (hoặc base64 của file) |

Hoặc thay bằng 3 biến: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`. Tuỳ chọn: `FIRESTORE_COLLECTION` (mặc định `license_keys`), `ALLOWED_ORIGIN` (mặc định `*`). Sau khi thêm biến phải **Redeploy**.

Mở `https://<project>.vercel.app/` → nhập `ADMIN_SECRET` → tạo key.

## 3. API cho client

### `POST /api/verify`

```json
{ "key": "PREM-ABCD-EFGH-JKLM-NPQR", "hwid": "chuoi-hwid-cua-may", "deviceName": "PC-Nam" }
```

Thành công (`200`):

```json
{
  "success": true, "key": "PREM-…", "tier": "premium", "duration": "month",
  "lifetime": false, "activatedAt": 1790000000000, "expiresAt": 1792592000000,
  "remainingMs": 2592000000, "deviceLock": true, "maxDevices": 2, "devicesUsed": 1,
  "serverTime": 1790000000000
}
```

Thất bại: `{ "success": false, "error": "<CODE>", "message": "…" }`

| error | HTTP | Ý nghĩa |
|---|---|---|
| `INVALID_KEY` | 404 | Key không tồn tại / sai định dạng |
| `KEY_BANNED` | 403 | Key bị khoá |
| `KEY_EXPIRED` | 403 | Hết hạn |
| `DEVICE_LIMIT` | 403 | Đã đủ số thiết bị, máy này chưa đăng ký |
| `HWID_REQUIRED` | 400 | Key bật khoá thiết bị nhưng không gửi `hwid` |
| `BAD_REQUEST` | 400 | Dữ liệu sai |

Gợi ý lấy HWID (nên **băm SHA-256** trước khi gửi):
Windows `(Get-CimInstance Win32_ComputerSystemProduct).UUID` · Linux `/etc/machine-id` · macOS `IOPlatformUUID` · Android `ANDROID_ID`.

**Python**

```python
import requests
r = requests.post("https://<project>.vercel.app/api/verify",
                  json={"key": KEY, "hwid": HWID, "deviceName": "PC-Nam"}, timeout=10)
d = r.json()
if d["success"]:
    print("OK", d["tier"], d["expiresAt"])
else:
    print("Lỗi:", d["error"], d["message"])
```

**Node / JS**

```js
const r = await fetch("https://<project>.vercel.app/api/verify", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ key, hwid, deviceName }),
});
const d = await r.json();
```

> Đừng tin hoàn toàn vào client: luôn kiểm tra `success`, và dùng `serverTime`/`expiresAt` từ server thay vì giờ máy người dùng.

## 4. API admin

Gửi header `x-admin-secret: <ADMIN_SECRET>` (hoặc `Authorization: Bearer <ADMIN_SECRET>`), body JSON.
Các action thao tác nhiều key nhận `key` hoặc `keys: [...]` (tối đa 500).

| Action | Body | Mô tả |
|---|---|---|
| `create` | `tier`, `duration`, `quantity`=1, `count`=1 (≤1000), `maxDevices`=1, `deviceLock`=true, `prefix`, `note` | Tạo key |
| `list` | `limit`=200 (≤1000) | Key mới nhất trước |
| `get` | `key` | Chi tiết 1 key + danh sách thiết bị |
| `ban` / `unban` | `key(s)`, `reason` | Khoá / mở khoá |
| `delete` | `key(s)` | Xoá |
| `reset-devices` | `key(s)`, `hwid`? | Gỡ tất cả (hoặc 1) thiết bị |
| `extend` | `key(s)`, `duration`, `quantity`=1 | Cộng thêm thời gian |
| `update` | `key(s)`, `tier`?, `maxDevices`?, `deviceLock`?, `note`? | Sửa thuộc tính |

Ví dụ: tạo 50 key premium 1 tháng, mỗi key dùng được trên 2 máy:

```bash
curl -X POST https://<project>.vercel.app/api/admin/create \
  -H "x-admin-secret: $ADMIN_SECRET" -H "Content-Type: application/json" \
  -d '{"tier":"premium","duration":"month","count":50,"maxDevices":2,"note":"đợt 1"}'
```

Các kiểu khác: `{"tier":"basic","duration":"hour"}`, `{"tier":"basic","duration":"day","quantity":3}`, `{"tier":"premium","duration":"lifetime","count":10}`.

## 5. Dữ liệu trong Firestore (`license_keys/{KEY}`)

`key, tier, duration, quantity, durationMs, deviceLock, maxDevices, status (active|banned), note, devices[{hwid,name,firstSeen,lastSeen}], createdAt, activatedAt, expiresAt, lastUsedAt` (thời gian là epoch ms).

## 6. Lưu ý bảo mật & vận hành

- Key có 80 bit ngẫu nhiên, không thể đoán. Việc gắn thiết bị chạy trong transaction nên 2 máy gọi cùng lúc không vượt được `maxDevices`.
- Nên bật **Vercel Firewall → Rate limiting** cho `/api/verify` và `/api/admin/*` để chống spam.
- `ADMIN_SECRET` bị lộ → đổi ngay trong Vercel rồi Redeploy. Service account bị lộ → vô hiệu hoá key trong Google Cloud IAM và tạo cái mới.
- Admin panel lưu secret trong `sessionStorage` (mất khi đóng tab).
- Chạy thử logic: `npm install && npm test`.
