Secara konsep valid, tapi ada beberapa lubang yang bakal bikin banyak bot lolos dan beberapa token bagus malah kena.

Yang gua setuju

✅ Pisahin Regularity dan Velocity

Karena:

Velocity tinggi ≠ bot

Regularity tinggi ≠ bot


Yang bahaya justru kombinasi keduanya.


---

Problem #1: Std Dev gampang dibypass

Bot modern gak beli:

500ms
500ms
500ms
500ms

Mereka beli:

430ms
610ms
520ms
390ms
700ms

Std dev langsung tinggi.

Padahal masih 100% bot.

Jadi kalau cuma pakai std dev:

Human -> lolos
Advanced bot -> lolos
Stupid bot -> ketangkep


---

Solusi lebih kuat

Hitung:

CV = stddev / meanInterval

Misal:

Bot:

500 510 490 505 495

mean = 500
std = 7

CV = 1.4%

Human:

100 800 200 1500 400

mean = 600
std = 520

CV = 86%

CV jauh lebih stabil dibanding std dev absolut.

Karena token dengan 50ms interval dan token dengan 500ms interval bisa dibandingkan.


---

Problem #2: Wallet per second bisa false positive

PumpFun launch bagus kadang:

80 wallet
10 detik

Masih organic.

Kalau lu kasih:

50 wallet / 10s = score 100

Banyak winner malah kena.


---

Yang lebih bagus

Gunakan velocity hanya sebagai multiplier.

Contoh:

if wps < 1.0 {
    velMultiplier = 0.5;
}

if wps >= 1.0 {
    velMultiplier = 1.0;
}

if wps >= 3.0 {
    velMultiplier = 1.3;
}

Lalu:

final = regularity * velMultiplier

Karena regularity lebih penting daripada velocity.


---

Problem #3: Lu belum cek wallet uniqueness

Bot swarm biasanya:

50 wallet
masing-masing beli 0.05 SOL

sangat seragam.

Organic:

0.02
0.3
0.1
1.5
0.8
0.05

acak.

Kalau mau kuat:

Tambahin:

Buy Size Entropy

atau

Buy Amount CV

Kalau semua wallet beli nominal hampir sama:

0.05
0.05
0.05
0.05

naikkan score.


---

Problem #4: Skip <30 detik terlalu agresif

Justru banyak scam ketahuan di:

0 - 20 detik pertama

Kalau lu skip total:

Token bot swarm
↓
score = 0
↓
PASS

Menurut gua lebih aman:

<15 detik → skip

15-30 detik → half confidence

>30 detik → full score


---

Yang paling penting

Kalau tujuan lu:

> "filter token PumpFun buat trading"



Maka Regularity 70% + Velocity 30% udah arah yang benar.

Tapi gua bakal ganti:

Regularity:
- CV interval
- Entropy interval

Velocity:
- max wallets/sec

Distribution:
- buy amount variance

Final:
40% interval CV
30% interval entropy
20% velocity
10% buy amount variance

Karena bot modern jauh lebih gampang menyamarkan kecepatan beli dibanding menyamarkan seluruh distribusi perilaku wallet secara bersamaan.

Jadi versi lu sekarang menurut gua sekitar 6.5/10 untuk nangkep bot swarm PumpFun. Dengan CV interval + buy amount variance, bisa naik ke 8.5/10 dan jauh lebih susah dibypass.
