"""
Regenerate APR fixture rows by recalculating the bank's APR workbook in LibreOffice (headless).

  python3 scripts/apr-workbook-fixtures.py /abs/path/APR_Model.xlsx /abs/path/out.json

Requires LibreOffice with Python-UNO. Each case writes Data!D5:D17, recalculates, and reads the
workbook's own outputs (Amortization Schedule G5:G9, APR Output E6/E11). Convert the output into
tests/fixtures/apr/<calculator>.json (format "workbook").
"""
import uno, json, sys, time, subprocess, os
from com.sun.star.beans import PropertyValue
XLSX=os.path.abspath(sys.argv[1]); OUT=sys.argv[2]
proc=subprocess.Popen(["soffice","--headless","--invisible","--norestore","--accept=socket,host=localhost,port=2002;urp;"])
local=uno.getComponentContext()
resolver=local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver",local)
for i in range(60):
    try: ctx=resolver.resolve("uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext"); break
    except Exception: time.sleep(1)
desktop=ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop",ctx)
p=PropertyValue(); p.Name="Hidden"; p.Value=True
doc=desktop.loadComponentFromURL("file://"+XLSX,"_blank",0,(p,))
data=doc.Sheets.getByName("Data"); am=doc.Sheets.getByName("Amortization Schedule"); out=doc.Sheets.getByName("APR Output")
def setv(cell,v):
    c=data.getCellRangeByName(cell)
    if isinstance(v,str): c.setString(v)
    else: c.setValue(v)
cases=[
 # name, type, amount, rate, rateType, freq, tenor, admin, takaful, stamp
 ("Workbook default inputs (tenor 144 shown for reference)", "MURABAHA",20000000,0.36,"FIXED","Monthly",144,0,0,0.00125),
]
amts=[1,250000,1000000,4999999.99,5000000,5000000.01,12345678.9,20000000,20000000.01,35000000,50000000]
i=0
for amt in amts:
    for (rate,rtype,freq,tenor,tak,stamp,ft) in [(0.36,"FIXED","Monthly",6,0,0.00125,"MURABAHA"),(0.30,"FIXED","Monthly",12,0.01,0.00125,"MURABAHA"),(0.28,"REDUCING","Monthly",9,0,0.00125,"MURABAHA"),(0.33,"FIXED","Quarterly",12,0.005,0.00125,"IJARAH")]:
        i+=1
        if i%3==0 or amt in (1,5000000,5000000.01,20000000,20000000.01,50000000):
            cases.append((f"{ft} {rtype} {freq} {tenor}m @{rate*100:g}% takaful {tak*100:g}% NGN {amt:,.2f}",ft,amt,rate,rtype,freq,tenor,0,tak,stamp))
for freq,tenor in [("Bi-monthly",12),("Termly",12),("Bi-annually",24),("Annually",36),("Bullet",3),("Bullet",12),("Monthly",1),("Monthly",60),("Monthly",24)]:
    cases.append((f"MURABAHA FIXED {freq} {tenor}m NGN 3,000,000",'MURABAHA',3000000,0.36,"FIXED",freq,tenor,0,0,0.00125))
    cases.append((f"MURABAHA REDUCING {freq} {tenor}m NGN 7,500,000.50",'MURABAHA',7500000.5,0.24,"REDUCING",freq,tenor,0,0.0075,0.00125))
res=[]
for (name,ft,amt,rate,rtype,freq,tenor,admin,tak,stamp) in cases:
    for cell,v in [("D5",ft),("D6",amt),("D7",rate),("D8",rtype),("D9",freq),("D10",tenor),("D13",admin),("D14",tak),("D15",stamp),("D16","No"),("D17",0)]: setv(cell,v)
    doc.calculateAll()
    g=lambda s,c: s.getCellRangeByName(c)
    r=dict(name=name,inputs=dict(facilityType=ft,amount=amt,markupRate=rate,rateType=rtype,frequency=freq,tenorMonths=tenor,adminFee=admin,takaful=tak,stampDuty=stamp),
      workbook=dict(totalPayments=g(data,"D11").Value,paymentsPerYear=g(data,"D12").Value,takaful=g(am,"G5").Value,stampDuty=g(am,"G6").Value,totalMarkup=g(am,"G7").Value,totalPayment=g(am,"G8").Value,periodicInstallment=g(am,"G9").Value,costOfFacility=g(out,"E6").Value,apr=g(out,"E11").Value,aprText=g(out,"E20").String))
    res.append(r); print(name, r["workbook"]["apr"], r["workbook"]["costOfFacility"], flush=True)
json.dump(res,open(OUT,"w"),indent=1)
doc.close(True); proc.terminate()
