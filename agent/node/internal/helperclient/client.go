// Package helperclient is the agent's side of exponetdb.helper/v1
// (architecture.md §2): it forwards an operation with the signed job that
// authorizes it and returns the helper's typed result or its refusal.
package helperclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"time"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
	"github.com/davdxpx/ExponetDB/agent/node/internal/helperproto"
)

// Client calls the helper on its socket.
type Client struct {
	Socket string
}

// ErrUnavailable: the helper could not be reached or answered nothing; the
// operation may or may not have run (an effect is then unknown).
var ErrUnavailable = errors.New("helper unavailable")

// Call sends op with the job envelope and waits for the answer until ctx
// ends. A refusal is a *helperproto.ErrorBody.
func (c *Client) Call(ctx context.Context, op string, envelope canon.Object) (canon.Object, error) {
	job, err := canon.Canonicalize(envelope)
	if err != nil {
		return nil, err
	}
	req, err := json.Marshal(helperproto.Request{V: helperproto.Version, Op: op, Job: job})
	if err != nil {
		return nil, err
	}
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", c.Socket)
	if err != nil {
		return nil, errors.Join(ErrUnavailable, err)
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	} else {
		_ = conn.SetDeadline(time.Now().Add(15 * time.Minute))
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Unix(1, 0)) })
	defer stop()
	if err := helperproto.WriteFrame(conn, req); err != nil {
		return nil, errors.Join(ErrUnavailable, err)
	}
	data, err := helperproto.ReadFrame(conn)
	if err != nil {
		return nil, errors.Join(ErrUnavailable, err)
	}
	if _, err := canon.Parse(data); err != nil {
		return nil, errors.Join(ErrUnavailable, err)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var resp helperproto.Response
	if err := dec.Decode(&resp); err != nil || resp.V != helperproto.Version || (resp.Error == nil) == (resp.Result == nil) {
		return nil, errors.Join(ErrUnavailable, errors.New("the helper answer is not exponetdb.helper/v1"))
	}
	if resp.Error != nil {
		return nil, resp.Error
	}
	v, err := canon.Parse(resp.Result)
	result, ok := v.(canon.Object)
	if err != nil || !ok {
		return nil, errors.Join(ErrUnavailable, errors.New("the helper result is not an object"))
	}
	return result, nil
}
