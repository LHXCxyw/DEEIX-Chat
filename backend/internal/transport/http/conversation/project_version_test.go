package conversation

import (
 "net/http/httptest"
 "strings"
 "testing"

 "github.com/gin-gonic/gin"
)

func TestWriteProjectFileRequestExpectedVersion(t *testing.T) {
 gin.SetMode(gin.TestMode)
 for _,tt:=range []struct{body string; want *int; invalid bool}{
  {body:`{"path":"a.txt","content":"x"}`},
  {body:`{"path":"a.txt","content":"x","expected_version":null}`},
  {body:`{"path":"a.txt","content":"x","expected_version":0}`,want:projectVersionPointer(0)},
  {body:`{"path":"a.txt","content":"x","expected_version":3}`,want:projectVersionPointer(3)},
  {body:`{"path":"a.txt","expected_version":-1}`,invalid:true},
  {body:`{"path":"a.txt","expected_version":1.5}`,invalid:true},
  {body:`{"path":"a.txt","expected_version":"1"}`,invalid:true},
 }{t.Run(tt.body,func(t *testing.T){
  c,_:=gin.CreateTestContext(httptest.NewRecorder())
  c.Request=httptest.NewRequest("POST","/",strings.NewReader(tt.body));c.Request.Header.Set("Content-Type","application/json")
  var req WriteProjectFileRequest
  err:=c.ShouldBindJSON(&req)
  if (err!=nil)!=tt.invalid{t.Fatalf("bind error=%v",err)}
  if !tt.invalid && ((req.ExpectedVersion==nil)!=(tt.want==nil) || (tt.want!=nil && *req.ExpectedVersion!=*tt.want)){t.Fatalf("version=%v,want=%v",req.ExpectedVersion,tt.want)}
 })}
}
func projectVersionPointer(value int)*int{return &value}
