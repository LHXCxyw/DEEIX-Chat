package agentoperation

import (
	"testing"
	"time"
)

func TestStateMachine(t *testing.T) {
	statuses := []Status{Pending, Running, Succeeded, Failed, Uncertain, Cancelled, Status("invalid")}
	for _, kind := range []Kind{ReadFile, ListDirectory, WriteFile, Command, Kind("invalid")} {
		for _, from := range statuses {
			for _, to := range statuses {
				want := from == Pending && (to == Running || to == Cancelled) || from == Running && (to == Succeeded || to == Failed || to == Uncertain) || from == Uncertain && to == Running && (kind == ReadFile || kind == ListDirectory)
				if got := CanTransition(kind, from, to); got != want {
					t.Errorf("%s %s->%s: %v", kind, from, to, got)
				}
			}
		}
	}
}

func TestParametersHash(t *testing.T) {
	a, err := ParametersHash([]byte(`{"b":[1,{"z":true}],"a":"x"}`))
	if err != nil {
		t.Fatal(err)
	}
	b, err := ParametersHash([]byte(`{ "a":"x", "b": [1, {"z":true}] }`))
	if err != nil || a != b {
		t.Fatal("规范化hash不一致", err)
	}
	c, _ := ParametersHash([]byte(`{"a":"y","b":[1,{"z":true}]}`))
	if a == c {
		t.Fatal("参数未绑定")
	}
	for _, raw := range []string{`{"a":1,"a":2}`, `{"a":{"x":1,"x":2}}`, `{} {}`, ``, `[1,]`} {
		if _, err := ParametersHash([]byte(raw)); err == nil {
			t.Errorf("应拒绝 %s", raw)
		}
	}
	a, _ = ParametersHash([]byte(`9007199254740992`))
	b, _ = ParametersHash([]byte(`9007199254740993`))
	if a == b {
		t.Fatal("数字精度丢失")
	}
}

func TestApprovalBinding(t *testing.T) {
	now := time.Now().UTC()
	hash, _ := ParametersHash([]byte(`{"path":"a"}`))
	spec := Spec{OwnerUserID: 1, OperationID: "op", RunID: "run", WorkspaceID: 2, Kind: Command, ParametersHash: hash, ExpectedWorkspaceVersion: "v1", PermissionScope: "workspace:command"}
	if err := spec.Validate(); err != nil {
		t.Fatal(err)
	}
	approval := Approval{Binding: spec.Binding(), GrantedAt: now, ExpiresAt: now.Add(MaxApprovalLifetime)}
	if err := approval.Validate(spec, now); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		change func(*Approval)
	}{
		{"hash", func(a *Approval) { a.ParametersHash = "other" }},
		{"version", func(a *Approval) { a.WorkspaceVersion = "v2" }},
		{"scope", func(a *Approval) { a.PermissionScope = "other" }},
		{"expired", func(a *Approval) { a.ExpiresAt = now }},
		{"too long", func(a *Approval) { a.ExpiresAt = now.Add(MaxApprovalLifetime + time.Nanosecond) }},
		{"future", func(a *Approval) { a.GrantedAt = now.Add(time.Second) }},
		{"zero", func(a *Approval) { a.GrantedAt = time.Time{} }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := approval
			tc.change(&a)
			if a.Validate(spec, now) == nil {
				t.Fatal("无效审批被接受")
			}
		})
	}
}
